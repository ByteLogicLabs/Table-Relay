//! MongoDB user / role administration via admin commands (`createUser`,
//! `updateUser`, `dropUser`, `usersInfo`, `connectionStatus`). Mongo's model is
//! role-based — roles (`readWrite`, `dbAdmin`, `root`, …) scoped per-database —
//! rather than SQL privileges, so access is carried as `RoleGrant { role, db }`
//! and set wholesale via `updateUser` (which replaces the role list).

use adapter_api::{
    AdapterError, AlterUserRequest, CreateUserRequest, ManageUsersCapability, RoleGrant, UserInfo,
    UserRef,
};
use mongodb::bson::{doc, Bson};

use crate::mongo::map_err;
use crate::MongoDriver;

/// Roles that let an account manage other users.
const ADMIN_ROLES: &[&str] = &["root", "userAdmin", "userAdminAnyDatabase", "dbOwner", "__system"];

/// Resolve the database a user command runs against: the explicit one, else the
/// connection's default database, else `admin`.
fn user_db(driver: &MongoDriver, database: Option<&str>) -> String {
    database
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| driver.default_db.clone())
        .unwrap_or_else(|| "admin".to_string())
}

fn roles_to_bson(roles: &[RoleGrant]) -> Vec<Bson> {
    roles
        .iter()
        .map(|r| Bson::Document(doc! { "role": &r.role, "db": &r.db }))
        .collect()
}

pub async fn can_manage_users(driver: &MongoDriver) -> Result<ManageUsersCapability, AdapterError> {
    let res = driver
        .client
        .database("admin")
        .run_command(doc! { "connectionStatus": 1 }, None)
        .await
        .map_err(map_err)?;
    let roles: Vec<String> = res
        .get_document("authInfo")
        .ok()
        .and_then(|a| a.get_array("authenticatedUserRoles").ok())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.as_document().and_then(|d| d.get_str("role").ok()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // No authenticated roles usually means an unauthenticated server (the
    // localhost exception) where every operation is permitted.
    let can = roles.is_empty() || roles.iter().any(|r| ADMIN_ROLES.contains(&r.as_str()));
    Ok(ManageUsersCapability {
        can_manage: can,
        reason: if can { String::new() } else { "requires a userAdmin / root role".into() },
    })
}

pub async fn list_users(driver: &MongoDriver) -> Result<Vec<UserInfo>, AdapterError> {
    let admin = driver.client.database("admin");
    // Prefer a cluster-wide listing; fall back to the current database's users
    // if the account lacks the privilege for `forAllDBs`.
    let res = match admin
        .run_command(doc! { "usersInfo": doc! { "forAllDBs": true } }, None)
        .await
    {
        Ok(r) => r,
        Err(_) => {
            let db = user_db(driver, None);
            driver
                .client
                .database(&db)
                .run_command(doc! { "usersInfo": 1 }, None)
                .await
                .map_err(map_err)?
        }
    };
    let arr = res.get_array("users").map_err(|e| AdapterError::Other(e.to_string()))?;
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        let Some(u) = entry.as_document() else { continue };
        let name = u.get_str("user").unwrap_or_default().to_string();
        let db = u.get_str("db").unwrap_or_default().to_string();
        let mut roles = Vec::new();
        if let Ok(rs) = u.get_array("roles") {
            for r in rs {
                if let Some(rd) = r.as_document() {
                    roles.push(RoleGrant {
                        role: rd.get_str("role").unwrap_or_default().to_string(),
                        db: rd.get_str("db").unwrap_or_default().to_string(),
                    });
                }
            }
        }
        let is_super = roles.iter().any(|r| r.role == "root");
        let attributes = if roles.is_empty() {
            Vec::new()
        } else {
            vec![roles.iter().map(|r| format!("{}@{}", r.role, r.db)).collect::<Vec<_>>().join(", ")]
        };
        out.push(UserInfo {
            name,
            host: None,
            can_login: None,
            is_superuser: Some(is_super),
            is_locked: None,
            attributes,
            roles,
            database: Some(db),
        });
    }
    Ok(out)
}

pub async fn create_user(driver: &MongoDriver, req: CreateUserRequest) -> Result<(), AdapterError> {
    let pwd = req
        .password
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AdapterError::Other("MongoDB requires a password to create a user.".into()))?;
    let db = user_db(driver, req.database.as_deref());
    let cmd = doc! {
        "createUser": &req.name,
        "pwd": pwd,
        "roles": roles_to_bson(&req.roles),
    };
    driver
        .client
        .database(&db)
        .run_command(cmd, None)
        .await
        .map_err(map_err)?;
    Ok(())
}

pub async fn alter_user(driver: &MongoDriver, req: AlterUserRequest) -> Result<(), AdapterError> {
    let db = user_db(driver, req.database.as_deref());
    let mut cmd = doc! { "updateUser": &req.name };
    let mut changed = false;
    if let Some(pw) = req.password.as_deref().filter(|s| !s.is_empty()) {
        cmd.insert("pwd", pw);
        changed = true;
    }
    if let Some(roles) = &req.roles {
        // updateUser replaces the whole role array, so send the desired set.
        cmd.insert("roles", roles_to_bson(roles));
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    driver
        .client
        .database(&db)
        .run_command(cmd, None)
        .await
        .map_err(map_err)?;
    Ok(())
}

pub async fn drop_user(driver: &MongoDriver, user: &UserRef) -> Result<(), AdapterError> {
    let db = user_db(driver, user.database.as_deref());
    driver
        .client
        .database(&db)
        .run_command(doc! { "dropUser": &user.name }, None)
        .await
        .map_err(map_err)?;
    Ok(())
}

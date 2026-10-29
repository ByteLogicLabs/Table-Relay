use std::collections::BTreeMap;

use adapter_api::{AdapterError, MutateRequest, Mutation};
use mongodb::bson::{Bson, Document, doc};

use crate::MongoDriver;
use crate::mongo::{json_to_bson, map_err};

pub(crate) async fn mutate(
    driver: &MongoDriver,
    req: MutateRequest,
) -> Result<Mutation, AdapterError> {
    match req {
        MutateRequest::Insert { schema, table, values } => {
            let coll = driver.collection(&schema, &table);
            let mut docu = Document::new();
            for (k, v) in values {
                docu.insert(k, json_to_bson(&v));
            }
            let res = coll.insert_one(docu, None).await.map_err(map_err)?;
            let generated_primary_key = match res.inserted_id {
                Bson::ObjectId(oid) => Some(BTreeMap::from([(
                    "_id".to_string(),
                    serde_json::Value::String(oid.to_hex()),
                )])),
                other => Some(BTreeMap::from([(
                    "_id".to_string(),
                    serde_json::Value::String(other.to_string()),
                )])),
            };
            Ok(Mutation {
                records_affected: 1,
                generated_primary_key,
            })
        }
        MutateRequest::Update {
            schema,
            table,
            primary_key,
            changes,
        } => {
            let coll = driver.collection(&schema, &table);
            let filter = pk_filter(primary_key)?;
            let mut set_doc = Document::new();
            for (k, v) in changes {
                set_doc.insert(k, json_to_bson(&v));
            }
            let res = coll
                .update_one(filter, doc! { "$set": set_doc }, None)
                .await
                .map_err(map_err)?;
            Ok(Mutation {
                records_affected: res.modified_count,
                generated_primary_key: None,
            })
        }
        MutateRequest::Delete {
            schema,
            table,
            primary_key,
        } => {
            let coll = driver.collection(&schema, &table);
            let filter = pk_filter(primary_key)?;
            let res = coll.delete_one(filter, None).await.map_err(map_err)?;
            Ok(Mutation {
                records_affected: res.deleted_count,
                generated_primary_key: None,
            })
        }
    }
}

fn pk_filter(keys: Vec<adapter_api::PrimaryKeyValue>) -> Result<Document, AdapterError> {
    if keys.is_empty() {
        return Err(AdapterError::Unsupported(
            "Mongo mutations require at least one primary-key field".to_string(),
        ));
    }
    let mut d = Document::new();
    for kv in keys {
        d.insert(kv.column, json_to_bson(&kv.value));
    }
    Ok(d)
}

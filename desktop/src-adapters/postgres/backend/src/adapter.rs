//! `Adapter` trait impl — forwards to inherent methods on `PostgresDriver`.

use std::sync::Arc;

use adapter_api::{
    Adapter, AdapterError, AlterUserRequest, BrowseRequest, BrowseResult, CommandWarning,
    CountRequest, CreateUserRequest, ForeignKey, GrantInfo, KillResult, ManageUsersCapability,
    MutateRequest, Mutation, ProcessInfo, QueryResult, RoutineDefinition, RoutineInfo,
    SaveTriggerRequest, SchemaInfo, ServerDetail, ServerInfo, SubscribeEvent, SubscribeRequest,
    SubscriptionHandle, TableStructure, TriggerDefinition, TriggerInfo, UserInfo, UserRef, ViewInfo,
};
use adapter_ssh::Tunnel;
use async_trait::async_trait;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

use crate::browse;
use crate::mutate;
use crate::subscribe;
use crate::PostgresDriver;

pub struct PostgresAdapter {
    pub(crate) driver: Arc<PostgresDriver>,
    /// SSH tunnel kept alive for the adapter's lifetime. `None` when
    /// the connection is direct. Matches the MySQL adapter's pattern.
    tunnel: Mutex<Option<Tunnel>>,
}

impl PostgresAdapter {
    pub fn new(driver: PostgresDriver) -> Self {
        Self::new_with_tunnel(driver, None)
    }

    pub fn new_with_tunnel(driver: PostgresDriver, tunnel: Option<Tunnel>) -> Self {
        Self {
            driver: Arc::new(driver),
            tunnel: Mutex::new(tunnel),
        }
    }
}

#[async_trait]
impl Adapter for PostgresAdapter {
    async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        self.driver.ping().await
    }

    async fn server_details(
        &self,
        schema: Option<&str>,
    ) -> Result<Vec<ServerDetail>, AdapterError> {
        self.driver.server_details(schema).await
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        self.driver.list_schemas().await
    }

    async fn list_databases(&self) -> Result<Vec<String>, AdapterError> {
        self.driver.list_databases().await
    }

    async fn describe_table(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, AdapterError> {
        self.driver.describe_table(schema, table).await
    }

    async fn describe_schema(
        &self,
        schema: &str,
    ) -> Result<Vec<TableStructure>, AdapterError> {
        self.driver.describe_schema(schema).await
    }

    async fn list_relations(
        &self,
        schema: &str,
    ) -> Result<Vec<ForeignKey>, AdapterError> {
        self.driver.list_relations(schema).await
    }

    async fn list_views(&self, schema: &str) -> Result<Vec<ViewInfo>, AdapterError> {
        self.driver.list_views(schema).await
    }

    async fn view_definition(&self, schema: &str, name: &str) -> Result<String, AdapterError> {
        self.driver.view_definition(schema, name).await
    }

    async fn list_routines(
        &self,
        schema: &str,
    ) -> Result<Vec<RoutineInfo>, AdapterError> {
        self.driver.list_routines(schema).await
    }

    async fn describe_routine(
        &self,
        schema: &str,
        name: &str,
        kind: &str,
    ) -> Result<RoutineDefinition, AdapterError> {
        self.driver.describe_routine(schema, name, kind).await
    }

    async fn list_triggers(&self, schema: &str) -> Result<Vec<TriggerInfo>, AdapterError> {
        self.driver.list_triggers(schema).await
    }

    async fn describe_trigger(
        &self,
        schema: &str,
        name: &str,
    ) -> Result<TriggerDefinition, AdapterError> {
        self.driver.describe_trigger(schema, name).await
    }

    async fn save_trigger(&self, req: SaveTriggerRequest) -> Result<(), AdapterError> {
        self.driver.save_trigger(req).await
    }

    async fn drop_trigger(
        &self,
        schema: &str,
        name: &str,
        table: &str,
    ) -> Result<(), AdapterError> {
        self.driver.drop_trigger(schema, name, table).await
    }

    async fn browse(&self, req: BrowseRequest) -> Result<BrowseResult, AdapterError> {
        browse::browse(&self.driver, req).await
    }

    async fn count_records(
        &self,
        req: CountRequest,
    ) -> Result<Option<u64>, AdapterError> {
        browse::count_records(&self.driver, req).await
    }

    async fn mutate(&self, req: MutateRequest) -> Result<Mutation, AdapterError> {
        mutate::mutate(&self.driver, req).await
    }

    async fn create_schema(
        &self,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> Result<(), AdapterError> {
        self.driver.create_schema(name, charset, collation).await
    }

    async fn list_all_collations(&self) -> Result<Vec<String>, AdapterError> {
        self.driver.list_all_collations().await
    }

    async fn execute_raw(
        &self,
        command: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError> {
        self.driver.run_query(command, row_limit).await
    }

    async fn execute_raw_scoped_stream(
        &self,
        command: &str,
        row_limit: Option<u32>,
        _schema: Option<&str>,
        sink: tokio::sync::mpsc::UnboundedSender<adapter_api::StatementResult>,
    ) -> Result<QueryResult, AdapterError> {
        self.driver.run_query_stream(command, row_limit, sink).await
    }

    async fn analyze_command(&self, command: &str) -> Vec<CommandWarning> {
        crate::analyze::analyze_command(command)
    }

    async fn process_list(&self) -> Result<Vec<ProcessInfo>, AdapterError> {
        self.driver.process_list().await
    }

    async fn kill_process(&self, id: &str) -> Result<(), AdapterError> {
        self.driver.kill_process(id).await
    }

    async fn kill_processes(&self, ids: &[String]) -> Result<Vec<KillResult>, AdapterError> {
        self.driver.kill_processes(ids).await
    }

    async fn can_manage_users(&self) -> Result<ManageUsersCapability, AdapterError> {
        self.driver.can_manage_users().await
    }

    async fn list_users(&self) -> Result<Vec<UserInfo>, AdapterError> {
        self.driver.list_users().await
    }

    async fn list_grants(&self, user: &UserRef) -> Result<GrantInfo, AdapterError> {
        self.driver.list_grants(user).await
    }

    async fn create_user(&self, req: CreateUserRequest) -> Result<(), AdapterError> {
        self.driver.create_user(req).await
    }

    async fn alter_user(&self, req: AlterUserRequest) -> Result<(), AdapterError> {
        self.driver.alter_user(req).await
    }

    async fn drop_user(&self, user: &UserRef) -> Result<(), AdapterError> {
        self.driver.drop_user(user).await
    }

    async fn subscribe(
        &self,
        req: SubscribeRequest,
        sink: UnboundedSender<SubscribeEvent>,
    ) -> Result<SubscriptionHandle, AdapterError> {
        subscribe::subscribe(&self.driver, req, sink).await
    }

    async fn shutdown(&self) {
        self.driver.shutdown().await;
        if let Some(mut t) = self.tunnel.lock().await.take() {
            t.shutdown().await;
        }
    }
}

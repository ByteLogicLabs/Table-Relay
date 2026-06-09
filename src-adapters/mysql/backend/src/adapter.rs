//! `Adapter` implementation. Thin wrapper over the inherent methods on
//! `MysqlDriver`; the driver speaks adapter-api types directly now, so
//! translation is down to zero-cost forwarding.

use std::sync::Arc;

use adapter_api::{
    Adapter, AdapterError, BrowseRequest, BrowseResult, CommandWarning, CountRequest, ForeignKey,
    KillResult, MutateRequest, Mutation, ProcessInfo, QueryResult, RoutineDefinition, RoutineInfo,
    SaveTriggerRequest, SchemaInfo, ServerInfo, TableStructure, TriggerDefinition, TriggerInfo,
    ViewInfo,
};
use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::browse;
use crate::mutate;
use crate::{MysqlDriver, Tunnel};

pub struct MysqlAdapter {
    pub(crate) driver: Arc<MysqlDriver>,
    /// SSH tunnel kept alive for the lifetime of the adapter. `None`
    /// when the connection is direct. Wrapped in `Mutex<Option<_>>` so
    /// `shutdown()` can take ownership and tear it down exactly once.
    tunnel: Mutex<Option<Tunnel>>,
}

impl MysqlAdapter {
    pub fn new_with_tunnel(driver: MysqlDriver, tunnel: Option<Tunnel>) -> Self {
        Self {
            driver: Arc::new(driver),
            tunnel: Mutex::new(tunnel),
        }
    }
}

#[async_trait]
impl Adapter for MysqlAdapter {
    async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        self.driver.ping().await
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        self.driver.list_schemas().await
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
        self.driver.create_database(name, charset, collation).await
    }

    async fn list_charsets(&self) -> Result<Vec<String>, AdapterError> {
        self.driver.list_charsets().await
    }

    async fn list_collations(&self, charset: &str) -> Result<Vec<String>, AdapterError> {
        self.driver.list_collations(charset).await
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

    async fn execute_raw_scoped(
        &self,
        command: &str,
        row_limit: Option<u32>,
        schema: Option<&str>,
    ) -> Result<QueryResult, AdapterError> {
        self.driver.run_query_scoped(command, row_limit, schema).await
    }

    async fn execute_raw_scoped_stream(
        &self,
        command: &str,
        row_limit: Option<u32>,
        schema: Option<&str>,
        sink: tokio::sync::mpsc::UnboundedSender<adapter_api::StatementResult>,
    ) -> Result<QueryResult, AdapterError> {
        self.driver.run_query_scoped_stream(command, row_limit, schema, sink).await
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

    async fn shutdown(&self) {
        self.driver.shutdown().await;
        if let Some(mut t) = self.tunnel.lock().await.take() {
            t.shutdown().await;
        }
    }
}

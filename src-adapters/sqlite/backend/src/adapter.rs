//! `Adapter` implementation — thin forwarding layer over `SqliteDriver`'s
//! inherent methods. The same shape as `adapter-mysql::MysqlAdapter` minus
//! the SSH tunnel, stored routines, and `create_schema`.

use std::sync::Arc;

use adapter_api::{
    Adapter, AdapterError, BrowseRequest, BrowseResult, CountRequest, ForeignKey, MutateRequest,
    Mutation, QueryResult, SaveTriggerRequest, SchemaInfo, ServerInfo, TableStructure,
    TriggerDefinition, TriggerInfo, ViewInfo,
};
use async_trait::async_trait;

use crate::SqliteDriver;
use crate::browse;
use crate::mutate;

pub struct SqliteAdapter {
    pub(crate) driver: Arc<SqliteDriver>,
}

impl SqliteAdapter {
    pub fn new(driver: SqliteDriver) -> Self {
        Self {
            driver: Arc::new(driver),
        }
    }
}

#[async_trait]
impl Adapter for SqliteAdapter {
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

    // Stored routines: SQLite has none. Fall back to the default
    // `Unsupported` trait implementations by not overriding the methods.

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

    // create_schema: SQLite has no `CREATE DATABASE`. Default impl returns
    // Unsupported, which is exactly what the manifest advertises.

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

    async fn shutdown(&self) {
        self.driver.shutdown().await;
    }
}

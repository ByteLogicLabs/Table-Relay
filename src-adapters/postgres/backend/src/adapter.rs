//! `Adapter` trait impl — forwards to inherent methods on `PostgresDriver`.

use std::sync::Arc;

use adapter_api::{
    Adapter, AdapterError, BrowseRequest, BrowseResult, CountRequest, ForeignKey, MutateRequest,
    Mutation, QueryResult, RoutineDefinition, RoutineInfo, SchemaInfo, ServerInfo, SubscribeEvent,
    SubscribeRequest, SubscriptionHandle, TableStructure, ViewInfo,
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

    async fn execute_raw(
        &self,
        command: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError> {
        self.driver.run_query(command, row_limit).await
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

use std::sync::Arc;

use adapter_api::{
    Adapter, AdapterError, BrowseRequest, BrowseResult, CommandWarning, CountRequest,
    ModifyIndexesRequest, MutateRequest, Mutation, ProcessInfo, QueryResult, SchemaInfo, ServerInfo,
    TableStructure,
};
use async_trait::async_trait;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

use crate::execute;
use crate::index;
use crate::mutate;
use crate::subscribe;
use crate::{MongoDriver, Tunnel};
use adapter_api::{SubscribeEvent, SubscribeRequest, SubscriptionHandle};

pub struct MongoAdapter {
    pub(crate) driver: Arc<MongoDriver>,
    /// SSH tunnel kept alive for the lifetime of the adapter. `None`
    /// when the connection is direct. Wrapped in `Mutex<Option<_>>` so
    /// `shutdown()` can take ownership and tear it down exactly once.
    tunnel: Mutex<Option<Tunnel>>,
}

impl MongoAdapter {
    pub fn new(driver: MongoDriver) -> Self {
        Self {
            driver: Arc::new(driver),
            tunnel: Mutex::new(None),
        }
    }

    pub fn new_with_tunnel(driver: MongoDriver, tunnel: Option<Tunnel>) -> Self {
        Self {
            driver: Arc::new(driver),
            tunnel: Mutex::new(tunnel),
        }
    }
}

#[async_trait]
impl Adapter for MongoAdapter {
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

    async fn browse(&self, req: BrowseRequest) -> Result<BrowseResult, AdapterError> {
        self.driver.browse(req).await
    }

    async fn count_records(
        &self,
        req: CountRequest,
    ) -> Result<Option<u64>, AdapterError> {
        self.driver.count_records(req).await
    }

    async fn mutate(&self, req: MutateRequest) -> Result<Mutation, AdapterError> {
        mutate::mutate(&self.driver, req).await
    }

    async fn modify_indexes(&self, req: ModifyIndexesRequest) -> Result<(), AdapterError> {
        index::modify_indexes(&self.driver, req).await
    }

    async fn execute_raw(
        &self,
        command: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError> {
        execute::execute_raw(&self.driver, command, row_limit).await
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

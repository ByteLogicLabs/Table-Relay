//! `Adapter` implementation — forwards to inherent methods on
//! `RedisDriver` + the per-intent modules.

use std::sync::Arc;

use adapter_api::{
    Adapter, AdapterError, BrowseRequest, BrowseResult, CountRequest, KillResult, MutateRequest,
    Mutation, ProcessInfo, QueryResult, SchemaInfo, ServerDetail, ServerInfo, SubscribeEvent,
    SubscribeRequest, SubscriptionHandle, TableStructure,
};
use async_trait::async_trait;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

use crate::browse;
use crate::execute;
use crate::mutate;
use crate::subscribe;
use crate::{RedisDriver, Tunnel};

pub struct RedisAdapter {
    pub(crate) driver: Arc<RedisDriver>,
    /// SSH tunnel kept alive for the lifetime of the adapter. `None`
    /// when the connection is direct. Wrapped in `Mutex<Option<_>>` so
    /// `shutdown()` can take ownership and tear it down exactly once.
    tunnel: Mutex<Option<Tunnel>>,
}

impl RedisAdapter {
    pub fn new(driver: RedisDriver) -> Self {
        Self {
            driver: Arc::new(driver),
            tunnel: Mutex::new(None),
        }
    }

    pub fn new_with_tunnel(driver: RedisDriver, tunnel: Option<Tunnel>) -> Self {
        Self {
            driver: Arc::new(driver),
            tunnel: Mutex::new(tunnel),
        }
    }
}

#[async_trait]
impl Adapter for RedisAdapter {
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

    // list_relations, list_views, list_routines, describe_routine,
    // create_schema → fall through to the trait's default `Unsupported`
    // impls. Redis has no equivalents.

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

    async fn execute_raw(
        &self,
        command: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError> {
        execute::execute_raw(&self.driver, command, row_limit).await
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

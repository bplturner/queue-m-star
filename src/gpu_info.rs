#[derive(Clone, Debug)]
pub struct GpuInfo {
    pub name: String,
    pub utilization: f32,
    pub power_usage: f32,
    pub power_limit: f32,
    pub memory_used: u64,
    pub memory_total: u64,
}

pub struct Response;

pub trait IntoResponse {
    fn into_response(self) -> Response;
}

/// Exported by the core and re-exported by nobody. Indexing it would be
/// indexing the whole dependency.
pub fn unrelated_helper() -> u32 {
    7
}

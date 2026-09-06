pub struct Html<T>(pub T);

#[doc(inline)]
pub use tiny_axum_core::response::{
    IntoResponse, Response,
};

pub use tiny_axum_core::extract::*;

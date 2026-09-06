pub trait FromRequest {
    fn from_request(&self) -> u32;
}

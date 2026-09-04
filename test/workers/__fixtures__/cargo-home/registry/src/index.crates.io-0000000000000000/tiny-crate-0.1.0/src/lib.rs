//! A tiny crate used as a docs fixture.

use std::fmt;

const SECRET: &str = "{ not a brace }";

/// How loudly to greet.
#[derive(Debug, Clone)]
pub enum Volume {
    Quiet,
    Loud,
}

/// A greeting, addressed to someone.
pub struct Greeting {
    pub name: String,
    pub volume: Volume,
    seen: bool,
}

/// Build a greeting for `name`.
pub fn greet(name: &str) -> String {
    let brace = '{';
    let _ = brace;
    if name.is_empty() {
        return String::from("hello");
    }
    format!("hello, {}", name)
}

fn private_helper(n: usize) -> usize {
    return n + 1;
}

pub(crate) fn crate_only() -> bool {
    true
}

/// Things that can be greeted.
pub trait Greetable {
    /// The name to greet by.
    fn display_name(&self) -> String;
}

impl Greeting {
    /// Make a quiet greeting.
    pub fn quiet(name: &str) -> Self {
        Greeting { name: name.to_string(), volume: Volume::Quiet, seen: false }
    }

    fn touch(&mut self) {
        self.seen = true;
    }
}

impl fmt::Display for Greeting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name)
    }
}

-- |
-- Module: Tiny.Value
-- A decoder whose declaration is one short line while the prose ABOUT it is long.
-- That is the from_str shape: serde_json's 91-byte `pub fn from_str<'a, T>` never
-- reaches the eight slots, and the 1159-byte chunk whose doc comments say
-- "signature", "error", "type" and "return" takes one every time.
module Tiny.Value where

-- | Decode a value.
decodeValue :: String -> Either String Int

-- | Decode a value, strictly.
decodeValueStrict :: String -> Either String Int

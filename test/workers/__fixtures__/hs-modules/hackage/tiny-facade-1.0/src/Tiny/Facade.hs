-- |
-- The facade shape: an export list and one trivial helper. `runSpec` and
-- `describeIt` are named here with no signature attached; `shouldMatch` is not
-- named at all, because `module Tiny.Facade.Expect` re-exports it wholesale.
module Tiny.Facade (
  runSpec
, describeIt
, module Tiny.Facade.Expect
, example
) where

import Tiny.Facade.Core
import Tiny.Facade.Expect

-- | A type-restricted id, so the facade declares exactly one signature.
example :: Int -> Int
example = id

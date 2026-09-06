module Tiny.Facade.Core (runSpec, describeIt, unrelatedHelper) where

-- | Run a spec tree.
runSpec :: String -> IO ()
runSpec = undefined

-- | Describe a group of examples.
describeIt :: String -> IO () -> IO ()
describeIt = undefined

-- | Not exported by the facade, so it must not be folded in.
unrelatedHelper :: Int -> Int
unrelatedHelper = id

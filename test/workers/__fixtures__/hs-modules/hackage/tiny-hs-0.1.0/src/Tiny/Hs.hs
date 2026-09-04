{-# LANGUAGE OverloadedStrings #-}
-- |
-- Module: Tiny.Hs
-- A tiny package used as a docs fixture.
module Tiny.Hs
    ( -- * Greeting
      greet
    , Greeting(..)
    , Volume(..)
    ) where

import Data.List (intercalate)

-- | How loudly to greet.
data Volume
    = Quiet
    | Loud
    deriving (Show, Eq)

-- | A greeting addressed to someone.
data Greeting = Greeting
    { greetingName   :: String
    , greetingVolume :: Volume
    }

-- | Build a greeting for a name.
greet :: String -> Volume -> String
greet name volume =
    let body = "hello, " ++ name
    in case volume of
        Quiet -> body
        Loud  -> map succ body

privateJoin :: [String] -> String
privateJoin = intercalate ", "

instance Show Greeting where
    show g = greet (greetingName g) (greetingVolume g)

-- |
-- Module: Tiny.Web
-- A route DSL whose handler types are aliases, so the definitions sit in one
-- small declaration while dozens of route functions USE them. That is the
-- scotty shape: 67 of 312 chunks name ActionM, one defines it.
module Tiny.Web where

-- | The handler monad.
type ActionM = ActionT IO

-- | The route-registration monad.
type ScottyM = ScottyT IO

-- | Add a get route.
get :: RoutePattern -> ActionM () -> ScottyM ()
get = addroute

-- | Add a post route.
post :: RoutePattern -> ActionM () -> ScottyM ()
post = addroute

-- | Add a put route.
put :: RoutePattern -> ActionM () -> ScottyM ()
put = addroute

-- | Add a delete route.
delete :: RoutePattern -> ActionM () -> ScottyM ()
delete = addroute

-- | Add a patch route.
patch :: RoutePattern -> ActionM () -> ScottyM ()
patch = addroute

-- | Add a options route.
options :: RoutePattern -> ActionM () -> ScottyM ()
options = addroute

-- | Add a matchAny route.
matchAny :: RoutePattern -> ActionM () -> ScottyM ()
matchAny = addroute

-- | Add a notFound route.
notFound :: RoutePattern -> ActionM () -> ScottyM ()
notFound = addroute

-- | Add a head_ route.
head_ :: RoutePattern -> ActionM () -> ScottyM ()
head_ = addroute

-- | Add a trace_ route.
trace_ :: RoutePattern -> ActionM () -> ScottyM ()
trace_ = addroute

-- | Add a connect_ route.
connect_ :: RoutePattern -> ActionM () -> ScottyM ()
connect_ = addroute

-- | Add a link_ route.
link_ :: RoutePattern -> ActionM () -> ScottyM ()
link_ = addroute

-- | Add a unlink_ route.
unlink_ :: RoutePattern -> ActionM () -> ScottyM ()
unlink_ = addroute

-- | Add a purge_ route.
purge_ :: RoutePattern -> ActionM () -> ScottyM ()
purge_ = addroute

-- | Add a copy_ route.
copy_ :: RoutePattern -> ActionM () -> ScottyM ()
copy_ = addroute

-- | Add a move_ route.
move_ :: RoutePattern -> ActionM () -> ScottyM ()
move_ = addroute

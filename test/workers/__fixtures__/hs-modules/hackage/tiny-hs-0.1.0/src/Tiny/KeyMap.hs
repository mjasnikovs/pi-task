-- |
-- Module: Tiny.KeyMap
-- The CPP shape. aeson's Data.Aeson.KeyMap declares its whole API twice, once
-- per `#ifdef USE_ORDEREDMAP` branch, and the extractor does not preprocess CPP.
-- 43 of aeson's 55 duplicate bodies are this file.
module Tiny.KeyMap where

#ifdef USE_ORDEREDMAP

-- | The union of two maps.
union :: KeyMap v -> KeyMap v -> KeyMap v

-- | Look a key up.
lookupKey :: Key -> KeyMap v -> Maybe v

#else

-- | The union of two maps.
union :: KeyMap v -> KeyMap v -> KeyMap v

-- | Look a key up.
lookupKey :: Key -> KeyMap v -> Maybe v

#endif

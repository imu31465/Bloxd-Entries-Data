# Bloxd.io Block/Item Data

Source: bloxd.io main bundle (/static/js/v98qt8.main.62d8d238.js)
Extracted: 2026-11-06T19:58:57.863Z

Extraction executes the registry-building code inside the bundle on the same JavaScript engine (V8) the game uses.
IDs and properties therefore match the live game (verified against the hardcoded ID table in the bundle).

## Updating

bloxd.io's main bundle is checked automatically by a GitHub Action (`.github/workflows/update.yml`) roughly every 5 minutes.
A run compares the bundle URL (its file name embeds a content hash) with `update-state.json`; if it changed, the data is
re-extracted and the diff is written to CHANGES.md. A run notes it in CHANGES.md even when the bundle changed but no entries did.
The extraction script `update.js` is included at the repository root (single file, zero dependencies, Node >= 18).
Run it manually with `node update.js`, `--force` (re-extract even if unchanged), or `--skip-fetch` (no network).

## Layout

- CHANGES.md : diff produced by the most recent update (added / removed / ID changes)
- entries.json : id↔name map for all entries (block+item) as [{id, name}] (sorted by id, contiguous 0..N)
- entries/     : one JSON per entry (file name starts with the 5-digit zero-padded ID, so name order = ID order; `kind` distinguishes block/item)
- update-state.json : internal state for the automatic update (bundle URL/hash of the last extraction)

State variants (orientation, open/closed, growth, charge, etc.) live in the same folder.
File names take the form `00165_Furnace.meta.rot2.json` (`|` in the original name replaced with `.`).
The `meta` field (rootName / rootId / metaStr) refers back to the base entry.

## ID Scheme

- 0 = Air (special value). 1 = Unloaded (unloaded chunk).
- Blocks: 0..8099 / Items: 8100..9591
- Blocks and items share one contiguous ID space (items start at the highest block ID + 1).

## Common Fields (all entries)

| Field | Meaning |
|---|---|
| id / name / kind | Numeric ID / canonical name (for the API) / block or item |
| displayName | Display name. key=translation key, text=English display name (unresolved if lookup fails) |
| description | Description (same structure as displayName) |
| meta | State variant info {rootName, rootId, metaStr, rot, open, ...}. Null keys are removed; omitted for base entries |
| rootMetaDesc | Fully qualified variant name (e.g. "Loot Chest|meta|rot4") |
| stackable | Whether the item is stackable |

## Block Fields

| Field | Meaning |
|---|---|
| ttb | Time To Break (ms) |
| harvestType | Break type such as granule / wood / rock / cuttable |
| harvestLevel | Required tool tier |
| drops | Drops when broken (omitted = itself, null = no drops) |
| specialToolDrop | {tool, drops} special drop for a specific tool |
| specialToolBonusDrops | {tool: [{bonusDrop, probabilityOfDrop}]} bonus drops |
| textureInfo | Texture name. Array = per face. RGBA number array = solid color (e.g. Water) |
| texturePerSide | Texture assignment index for the 6 faces |
| atlasIdx | Index in the texture atlas (array for animations) |
| model | Render model such as CentreCross / rotatable / SquareSided / CustomModel |
| solid | Whether the block has collision |
| soundType | {break, place} break/place sounds |
| damage | Damage on contact (e.g. cactus) |
| stoodOnSpeedMultiplier | Movement speed multiplier while standing on the block |
| canBePlacedOver / attachedTop / slabFullBlock | Placement behavior flags |
| onMinedAura | Particle color when mined |
| kV | Door/trapdoor state -> mesh mapping |

## Item Fields

| Field | Meaning |
|---|---|
| type | Classification such as Gun / Tool / Chargeable |
| weight | Carried weight |
| damage / attackRange / secondaryDamage | Weapon damage / attack range |
| harvests / multiplier / level | Tool targets, speed multiplier, tier |
| armourReduction / knockbackReduction | Armour stats |
| eatable / eatHealAmt / afterEatenItem | Food stats |
| chargeTime / chargeStages / chargeSound | Charge behavior |
| fireRate / reloadTime / clipSize / inaccuracy* / kickback* / scopeType | Gun stats |
| fishingRodInfo / comboInfo / dashImpulse | Special action parameters |
| heldItemGlb / textureInfo | Held 3D model / texture |

## Notes

- displayName.text is resolved from the English table embedded in the bundle (other languages are fetched separately at game startup and are not included)
- atlasIdx is auxiliary info that can change with the texture pack configuration at runtime
- meta is output with null keys removed (base entries omit meta entirely)

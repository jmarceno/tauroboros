# Pi local skills setup

This project keeps Pi skills local and reproducible inside `tauroboros/`.

## Layout

- Source of truth (tracked): `skills/<skill-name>/SKILL.md`
- Pi runtime location (generated): `.pi/skills/<skill-name>/SKILL.md`
- Infrastructure config (tracked): `.tauroboros/settings.json`

The runtime directory is generated from source. The Rust backend embeds skills and extensions directly into the binary via `include_dir!` and extracts them to `.pi/` at startup (see `src/backend/src/embedded_resources.rs`).

Core workflow behavior should not depend on global skill installation.

## Commands

From `tauroboros/` (requires Bun for scripts):

```bash
bun run skills:sync
```

Incrementally copies source skills to `.pi/skills/`.

```bash
bun run skills:install
```

Performs a clean install (`--clean`): removes `.pi/skills/` then copies all source skills.

```bash
bun run skills:verify
```

Verifies:

- source skills exist
- each skill has required frontmatter
- `.tauroboros/settings.json` is valid and configured for local skills
- `.pi/skills/` is writable

```bash
bun run setup
```

Runs full reproducible setup (`skills:install` + `skills:verify`).

## Adding a new skill

1. Create `skills/<new-skill>/SKILL.md`.
2. Include YAML frontmatter with at least `name` and `description`.
3. Run `bun run skills:sync` (or `bun run skills:install`).
4. Rebuild the Rust backend so the new skill is embedded in the binary.

## Settings

`.tauroboros/settings.json` contains infrastructure configuration including:

- `skills.localPath = "./skills"`
- `skills.autoLoad = true`
- `skills.allowGlobal = false`
- `workflow.server.port` - Server port
- `workflow.server.dbPath` - Database location
- `workflow.container.*` - Container isolation settings

This ensures Pi uses project-local skills and avoids global skill drift.

## Troubleshooting

- **"No skills found"**: ensure each skill folder contains `SKILL.md`.
- **Settings validation failed**: check `.tauroboros/settings.json` fields and JSON syntax.
- **Skill changes not visible in Rust binary**: rebuild the backend (`cargo build`) — the Rust binary embeds skills at compile time via `include_dir!`.
- **Permission errors writing `.pi/skills`**: ensure the workspace is writable.

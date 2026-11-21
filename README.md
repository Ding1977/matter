# Matter

Matter connects the digital and physical worlds — a tool for humans and agents to work together.

## Commands

Install first: `pnpm install`.

```sh
pnpm run typecheck    # type-check all packages
pnpm run test         # run unit tests
pnpm run build        # build all packages
pnpm run lint         # static checks
```

## Layout

```
packages/            self-owned packages (@matter/<name>), at packages/<group>/<pkg>/
  api/               interface layer (Remote RPC controllers)
  client/            frontend (theme tokens · block editor · knowledge-base UI)
  kb/                knowledge base (document domain · block engine)
  pm/                task line (issue · project)
  storage/           data storage (JSON entities · SQLite events · search)
```

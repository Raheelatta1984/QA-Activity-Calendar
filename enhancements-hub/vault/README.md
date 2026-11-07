# Vault

Markdown handover documents, laid out per tenant and application:

```
vault/
└── <tenant>/
    └── <application>/
        ├── ENH-0001-title-slug.md        active handovers (Building / Built)
        └── archived/
            └── ENH-0001-title-slug.md    completed records (Archived)
```

These files are the durable record of what the hub published. The database
follows the files (never the other way round):

- a file in `archived/` ⇒ its enhancement becomes **Archived**
- a file with `status: "Built"` ⇒ its enhancement is promoted to **Built**

Reconcile manually with `npm run sync` (or `POST /api/v1/sync`); the hub also
reconciles on boot when documents are present. Commit this folder with every
change set, exactly like the source project's `enhancements/` vault. Files
written by the hub land here automatically; on read-only/serverless filesystems
the hub falls back to a temp directory and says so in every response
(`vault.ephemeral`).

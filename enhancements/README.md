# Enhancement vault

Markdown proposals submitted through **Future Enhancements** (`tab.enhancements`) are written here with YAML frontmatter so they can be reviewed with every change set.

- Active proposals: `enhancements/*.md`
- Built, tested and closed: `enhancements/archive/*.md`

Workflow:

```bash
git add enhancements
git commit -m "docs(enhancements): capture latest proposals"
git push
```

Archiving in the app moves the file into `archive/` automatically, so a shipped request is not re-reviewed.

This folder is the **in-app proposal vault**. The approved handovers that drive GitHub
automation live one level down in `lib/future-enhancements/`, follow the same
status lifecycle (`Building` → `Built` → `Archived`) and are reconciled with the
database on every deployment that bundles them — see
[`docs/ENHANCEMENT-AUTOMATION.md`](../docs/ENHANCEMENT-AUTOMATION.md#handover-lifecycle-and-status-truth).

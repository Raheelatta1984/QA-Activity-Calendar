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

Archiving in the app moves the file into `archive/` automatically, so a shipped request is not re-reviewed. The database remains the source of truth for status; the Markdown files are the portable, reviewable record.

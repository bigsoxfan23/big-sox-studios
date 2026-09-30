# Big Sox Studios Content Editor

The editor lives at `/admin/` and uses GitHub OAuth with Sveltia CMS.

Routine content edits use Editorial Workflow: save a draft, send it for review, confirm the GitHub Validate check and Cloudflare preview succeed, then publish. Publishing merges the CMS pull request into `main` and triggers the normal Cloudflare production deployment.

Code, layouts, styling, components, deployment configuration, brand masters, and private infrastructure are intentionally not editable in the CMS.

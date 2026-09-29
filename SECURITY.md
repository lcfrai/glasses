# Trust boundaries

Glasses is a local-first development tool. Keep the HTTP service on loopback; it is not a hosted multi-user backend. Requests use a local session token and enforce origin checks. The public website serves only a static catalogue projection and never proxies to a user's local service.

Treat repository descriptions, source code, model outputs and shared catalogue files as untrusted data. A valid content hash checks integrity, not publisher identity or software safety. Import a pack only from a publisher you trust. Shared observations are kept separately from locally retained source evidence and local classification results.

The reviewed preview dependency set and opaque iframe limit visual trials. They are not a container sandbox for arbitrary packages, install scripts or services. Evaluate whole products in a suitable isolated environment before adopting them into a real project or agent memory.

API keys, workspaces, outcome notes, settings, research history and databases are private local state. Do not publish `.glasses`, logs or exported workspaces without reviewing their contents. The public pack exporter excludes these fields and source bodies; it does not clear third-party intellectual property rights.

Please report a suspected vulnerability privately through the contact link at https://lcfr.ai rather than publishing credentials or private data in an issue. Include a minimal synthetic reproduction and the affected version.

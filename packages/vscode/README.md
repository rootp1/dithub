# Dithub for VS Code

Need-to-know development on Dithub, inside VS Code.

- **Maintainers**: sign in, open the **Issues** view, pick a repository you maintain, and run **Assign with 0G…** on an issue. Type `@username`; 0G reads the issue and suggests the relevant files; review them, choose a role and a duration, confirm. The developer gets a time-boxed session for only those paths and never gets repository access.
- **Developers**: the **My Tasks** view lists the tickets assigned to you. **Connect with 0G** opens a task as a virtual folder (`dithub-task://<session>/`) that contains only the allowed files. Edits are kept by the extension (not written to disk as repo files). **Ask 0G** answers questions sealed on 0G Private Computer, **Submit changes** opens a pull request, **End task** gives the access back.

Sign-in uses a device code approved in the browser; the token is kept only in VS Code's secret storage. Setting: `dithub.host`.

See `docs/vscode-extension.md` in the Dithub repository for details.

# Status

A hello-world skeleton with every check in place:

- `backend/`: one route, `GET /api/health`
- `agent/`: the entry point `run(claim_id, thread_id)`, with one tool that calls the health route
- `dashboard/`: one page that shows whether the backend is up
- `e2e/`: one test of that page

Nothing of UnderCover is built yet. Update this file as you build.

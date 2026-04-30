# Studio OS

錄音室與樂器教室內部管理 Web App。

## Features

- Role-based login for owner, staff, and admin views
- Case management with status filters and checklist progress
- Owner-only finance view
- PostgreSQL-backed API for persistent project data
- Mobile-first dark UI

## Environment

Set one of these variables in the deployment environment:

```bash
DATABASE_URL=postgresql://...
```

On Zeabur, the web service can use:

```bash
DATABASE_URL=${POSTGRES_CONNECTION_STRING}
```

## Run

```bash
npm install
npm start
```

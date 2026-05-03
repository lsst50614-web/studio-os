# Studio OS

錄音室與樂器教室內部管理 Web App。

## Features

- Account-based login for owner and staff views
- Case management with status filters and checklist progress
- Owner-only finance view
- Owner-only admin records for company status and petty cash
- Owner-created employee email accounts with hashed passwords
- Employees choose their monthly work types after logging in
- Owner-only case creation and assignment
- Petty cash payment status tracking for paid and pending expenses
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

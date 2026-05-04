# 晨嵐音樂

錄音室營運管理 Web App。

## Features

- Account-based login for owner and staff views
- Case management with status filters and checklist progress
- Studio rental service with hourly pricing presets and custom rates
- Owner can edit case notes after creation
- Owner can correct the primary person responsible for a case after creation
- Review guidance appears only when the case enters review or revision status
- Owner-only finance view
- Owner-only admin records for company status and petty cash
- Owner-created employee email accounts with hashed passwords
- Owner can reset employee temporary passwords
- Employees choose their monthly work types after logging in
- Owner-only case creation and assignment
- Employee fixed monthly salary plus per-case split settings for fixed pay, percentage commission, and multi-person payouts
- Staff expense claims with receipt photo upload
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

# Importing employees from CSV

**Who can import:** users with the *Import employees* permission (HR Officer and Super Admin by default).

## Prepare the file
- Save it as **CSV UTF-8**: in Excel, use File, then Save As, then "CSV UTF-8 (Comma delimited)". UTF-16 files and `.xlsx` workbooks are rejected with a message.
- The first row must contain the column names. A column's position doesn't matter, and you can match each column to a field on screen.
- Limits: 5 MB and 10,000 rows per file.

| Field | Required | Notes |
|---|---|---|
| Employee ID | Yes | From your HR system. Must be unique; case is ignored (`e001` = `E001`). |
| Full name | Yes | |
| Email, Phone, Job title | No | Duplicate emails produce a warning or a rejection, per Settings. |
| Department | No | Name or code of an **existing, active** department. |
| Team / process | No | Name (within the department) or code. If no department is given, the team's department is used. |
| Manager's employee ID | No | An existing current employee, or another row in the same file. |
| Work location | No | Location code, or a unique location name. |
| Employment status | No | Active (default), On leave, Notice period. Exited staff can't be imported. |
| Joining date, Expected exit date | No | Choose the date format used in the file (YYYY-MM-DD, DD-MM-YYYY or MM-DD-YYYY). |

Example:
```csv
Employee ID,Full Name,Email,Department,Team,Manager ID,Location,Date of Joining
E001,Asha Menon,asha@example.com,OPS,,,PUN,2025-06-01
E002,"Kumar, Ravi",ravi@example.com,Operations,Voice Support,E001,PUN,2026-01-15
```

## What happens
1. **Choose file.** The file is read and checked. Nothing is saved yet.
2. **Map and review.** Every row is shown with a status:
   - *Accepted*: will be imported.
   - *Accepted with warning*: will be imported; read the note.
   - *Rejected*: has errors; the message says what to fix.
   - *Duplicate*: the Employee ID already exists or appears twice in the file. Existing employees are **never overwritten**.
3. **Import.** If any row is rejected or duplicate, either correct the file and choose it again, or tick *Skip the rejected and duplicate rows*. The import saves **all accepted rows or none**. If anything fails while saving, nothing is saved.

Each import is recorded in the audit log with counts and a file fingerprint. Employee details are not copied into the log.

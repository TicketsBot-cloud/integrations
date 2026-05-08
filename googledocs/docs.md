# Google Docs (Google Sheets) User Guide

This guide is for users only.

It assumes the integration is already live and connected by your admin/developer. You do not need to deploy anything.

## What this integration does

When ticket activity happens, the system writes or updates one row in your Google Sheet.

Common ticket events that update the sheet:

1. Ticket opened
2. Ticket claimed/unclaimed
3. First response sent
4. Close requested
5. Ticket closed

## What you need to do as a user

### 1. Setting up the Google Sheet

1. Open or create a sheet, and get the id (the long string in the url)
2. Create/rename a tab, and keep this in mind (default `Tickets`).
3. Give the system editor access to the document. Email: rankblox-docs-bot@gmail-to-discord-340802.iam.gserviceaccount.com

### 2. Confirm headers are present

Your tickets tab should have these columns in row 1:

1. Ticket ID
2. Channel ID
3. Status
4. Guild ID
5. User ID
6. Claimed By
7. Close Requested By
8. Opened At
9. First Reply At
10. Closed At
11. Panel Title

The integration should write them automatically.

### 3. Use your ticket system normally

You do not manually push data to Google Sheets.

Just use the ticket bot/panel as usual:

1. Open a ticket
2. Claim or unclaim it
3. Reply to it
4. Request close or close it

The sheet should update shortly after each action.

### 4. Check if sync is working

After you perform an action in tickets:

1. Refresh the sheet.
2. Find the ticket by `Ticket ID` or `Channel ID`.
3. Confirm fields changed as expected:
   - `Status` reflects the latest state (`open`, `claimed`, `close_requested`, `closed`, etc.)
   - `First Reply At` fills after first staff reply
   - `Closed At` fills when closed
   - `Claimed By` and `Close Requested By` reflect user IDs from ticket actions

### 5. Understand expected delay

Small delay is normal.

Writes are queued and debounced to reduce spam/duplicates, so updates can take a short moment to appear.
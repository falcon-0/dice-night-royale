# Microsoft Access reporting

Dice Night uses PostgreSQL for live gameplay. Microsoft Access connects only to a safe reporting schema, so it cannot read profile PIN hashes, session tokens, rejoin keys, or active room credentials.

## Views to link

- `access_reporting.match_records`: one row for each player in each completed match
- `access_reporting.player_leaderboard`: profile XP and lifetime totals
- `access_reporting.profile_achievements`: unlocked profile achievements

Never connect Access with the application's PostgreSQL owner account.

## Connect from Windows

1. Install the PostgreSQL Unicode x64 ODBC driver matching Microsoft Access.
2. Open **ODBC Data Sources (64-bit)** and create a System DSN.
3. Enter the hosted PostgreSQL hostname, port, database, reporting username, and password.
4. In Access, choose **External Data > New Data Source > From Other Sources > ODBC Database**.
5. Choose **Link to the data source** and select the three views in the `access_reporting` schema.

The Falcon control deck also has **Export for Access**, which downloads flattened match records as a UTF-8 CSV.

## Read-only reporting account

Run these commands as the PostgreSQL owner, replacing the database name and password:

    CREATE ROLE dice_access_reader LOGIN PASSWORD 'use-a-long-random-password';
    GRANT CONNECT ON DATABASE dice_night TO dice_access_reader;
    GRANT USAGE ON SCHEMA access_reporting TO dice_access_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA access_reporting TO dice_access_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA access_reporting
      GRANT SELECT ON TABLES TO dice_access_reader;

Do not grant this account access to the `public` schema. Keep both database passwords outside GitHub.

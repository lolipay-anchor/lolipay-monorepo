# Conformance test runs (SOW evidence)

These are the console outputs of the SDF `stellar-anchor-tests` runs cited in the SOW final report, with terminal colour codes removed.

## L07 — SEP-12 conformance run, 2026-09-10 03:59 UTC

Result: `Tests: 14 passed, 14 total`.

```text
✔ SEP-1 ‣ TOML Tests ‣ the TOML file exists at ./well-known/stellar.toml
✔ SEP-12 ‣ TOML Tests ‣ has KYC_SERVER attribute
✔ SEP-12 ‣ PUT /customer ‣ requires a SEP-10 JWT
✔ SEP-10 ‣ TOML Tests ‣ has a valid WEB_AUTH_ENDPOINT in the TOML file
✔ SEP-10 ‣ POST /auth ‣ returns a valid JWT
✔ SEP-12 ‣ PUT /customer ‣ can create a customer
✔ SEP-12 ‣ PUT /customer ‣ memos differentiate customers registered by the same account
✔ SEP-12 ‣ GET /customer ‣ requires a SEP-10 JWT
✔ SEP-1 ‣ TOML Tests ‣ has a valid network passphrase
✔ SEP-12 ‣ GET /customer ‣ has a valid schema for a new customer
✔ SEP-12 ‣ GET /customer ‣ can retrieve customer using 'id'
✔ SEP-12 ‣ GET /customer ‣ can retrieve customer using SEP-10 token
✔ SEP-12 ‣ DELETE /customer ‣ requires a SEP-10 JWT
✔ SEP-12 ‣ DELETE /customer ‣ can delete a customer

Tests:       14 passed, 14 total
Time:        8.433s
```

## L14 — SEP-24 conformance run, 2026-09-03, withdrawal switched off

Result: `Tests: 12 failed, 30 passed, 1 skipped, 43 total`. Withdrawal was switched off; every failure and the skip were withdrawal checks.

```text
npm notice run lolipay-coordinator@0.0.1 anchor:test:sep24
npm notice run stellar-anchor-tests --home-domain "${ANCHOR_TEST_DOMAIN:-lolipay.app}" --seps 24 --sep-config anchor-tests/sep-config.local.json
✔ SEP-1 ‣ TOML Tests ‣ the TOML file exists at ./well-known/stellar.toml
✔ SEP-24 ‣ TOML Tests ‣ has a valid transfer server URL
✔ SEP-24 ‣ /info ‣ response is compliant with the schema
✔ SEP-24 ‣ /info ‣ configured asset code is enabled for deposit
✖ SEP-24 ‣ /info ‣ configured asset code is enabled for withdraw

  Failure Type:

    configured asset code not enabled

  Description:

    USDC is not enabled for SEP-24

  Resource Links:

    Info for Assets: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#for-each-withdrawal-asset-response-contains

✔ SEP-24 ‣ /deposit ‣ requires a SEP-10 JWT for deposit
✔ SEP-10 ‣ TOML Tests ‣ has a valid WEB_AUTH_ENDPOINT in the TOML file
✔ SEP-10 ‣ POST /auth ‣ returns a valid JWT
✔ SEP-24 ‣ /deposit ‣ requires 'asset_code' parameter for deposit
✔ SEP-24 ‣ /deposit ‣ rejects invalid 'account' parameter
✔ SEP-24 ‣ /deposit ‣ rejects unsupported 'asset_code' parameter for deposit
✔ SEP-24 ‣ /deposit ‣ returns a proper schema for valid deposit requests
✖ SEP-24 ‣ /withdraw ‣ requires a SEP-10 JWT for withdraw

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /info
    Assertion: configured asset code is enabled for withdraw

✖ SEP-24 ‣ /withdraw ‣ requires 'asset_code' parameter for withdraw

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /info
    Assertion: configured asset code is enabled for withdraw

✖ SEP-24 ‣ /withdraw ‣ rejects unsupported 'asset_code' parameter for withdraw

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /info
    Assertion: configured asset code is enabled for withdraw

✖ SEP-24 ‣ /withdraw ‣ returns a proper schema for valid withdraw requests

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /info
    Assertion: configured asset code is enabled for withdraw

✔ SEP-24 ‣ /transaction ‣ requires a SEP-10 JWT on /transaction
✔ SEP-24 ‣ /transaction ‣ has a record on /transaction after a deposit request
✖ SEP-24 ‣ /transaction ‣ has a record on /transaction after a withdraw request

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /withdraw
    Assertion: returns a proper schema for valid withdraw requests

✔ SEP-24 ‣ /transaction ‣ has proper 'incomplete' deposit transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ has proper 'pending_' deposit transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ has proper 'completed' deposit transaction schema on /transaction
✖ SEP-24 ‣ /transaction ‣ has proper 'incomplete' withdraw transaction schema on /transaction

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /withdraw
    Assertion: returns a proper schema for valid withdraw requests

✖ SEP-24 ‣ /transaction ‣ has proper 'pending_user_transfer_start' withdraw transaction schema on /transaction

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /withdraw
    Assertion: returns a proper schema for valid withdraw requests

✖ SEP-24 ‣ /transaction ‣ has proper 'completed' withdraw transaction schema on /transaction

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /withdraw
    Assertion: returns a proper schema for valid withdraw requests

✔ SEP-24 ‣ /transaction ‣ returns valid deposit transaction when using 'stellar_transaction_id' param
▸ SEP-24 ‣ /transaction ‣ returns valid withdraw transaction when using 'stellar_transaction_id' param
✔ SEP-24 ‣ /transaction ‣ has a valid 'more_info_url'
✔ SEP-24 ‣ /transaction ‣ returns 404 for a nonexistent transaction 'id'
✔ SEP-24 ‣ /transaction ‣ returns 404 for a nonexistent 'external_transaction_id'
✔ SEP-24 ‣ /transaction ‣ returns 404 for a nonexistent 'stellar_transaction_id'
✔ SEP-24 ‣ /transactions ‣ requires a SEP-10 JWT on /transactions
✔ SEP-24 ‣ /transactions ‣ has a record on /transactions after a deposit request
✖ SEP-24 ‣ /transactions ‣ has a record on /transactions after a withdraw request

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /info
    Assertion: configured asset code is enabled for withdraw

✔ SEP-24 ‣ /transactions ‣ has proper deposit transaction schema on /transactions
✖ SEP-24 ‣ /transactions ‣ has proper withdraw transaction schema on /transactions

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /withdraw
    Assertion: returns a proper schema for valid withdraw requests

✔ SEP-24 ‣ /transactions ‣ returns an empty list for accounts with no transactions
✔ SEP-24 ‣ /transactions ‣ returns proper number of transactions when 'limit' parameter is given
✔ SEP-24 ‣ /transactions ‣ transactions are returned in descending order of creation
✔ SEP-24 ‣ /transactions ‣ returns proper transactions when 'no_older_than' parameter is given
✖ SEP-24 ‣ /transactions ‣ only returns withdraw transactions when kind=withdrawal

  Failure Type:

    failed dependency

  Description:

    A test dependency failed

    SEP: 24
    Group: /transaction
    Assertion: has proper 'incomplete' withdraw transaction schema on /transaction

✔ SEP-24 ‣ /transactions ‣ only returns deposit transactions when kind=deposit
✔ SEP-24 ‣ /transactions ‣ rejects requests with a bad 'asset_code' parameter

Tests:       12 failed, 30 passed, 1 skipped, 43 total
Time:        2.412s
```

## L15 — SEP-24 conformance run, 2026-09-04, withdrawal switched on

Result: `Tests: 42 passed, 1 skipped, 43 total`. Withdrawal was switched on; the skipped check is `SEP-24 ‣ /transaction ‣ has proper 'pending_user_transfer_start' withdraw transaction schema on /transaction`.

```text
suite start 2026-09-04T20:12:16Z
✔ SEP-1 ‣ TOML Tests ‣ the TOML file exists at ./well-known/stellar.toml
✔ SEP-24 ‣ TOML Tests ‣ has a valid transfer server URL
✔ SEP-24 ‣ /info ‣ response is compliant with the schema
✔ SEP-24 ‣ /info ‣ configured asset code is enabled for deposit
✔ SEP-24 ‣ /info ‣ configured asset code is enabled for withdraw
✔ SEP-24 ‣ /deposit ‣ requires a SEP-10 JWT for deposit
✔ SEP-10 ‣ TOML Tests ‣ has a valid WEB_AUTH_ENDPOINT in the TOML file
✔ SEP-10 ‣ POST /auth ‣ returns a valid JWT
✔ SEP-24 ‣ /deposit ‣ requires 'asset_code' parameter for deposit
✔ SEP-24 ‣ /deposit ‣ rejects invalid 'account' parameter
✔ SEP-24 ‣ /deposit ‣ rejects unsupported 'asset_code' parameter for deposit
✔ SEP-24 ‣ /deposit ‣ returns a proper schema for valid deposit requests
✔ SEP-24 ‣ /withdraw ‣ requires a SEP-10 JWT for withdraw
✔ SEP-24 ‣ /withdraw ‣ requires 'asset_code' parameter for withdraw
✔ SEP-24 ‣ /withdraw ‣ rejects unsupported 'asset_code' parameter for withdraw
✔ SEP-24 ‣ /withdraw ‣ returns a proper schema for valid withdraw requests
✔ SEP-24 ‣ /transaction ‣ requires a SEP-10 JWT on /transaction
✔ SEP-24 ‣ /transaction ‣ has a record on /transaction after a deposit request
✔ SEP-24 ‣ /transaction ‣ has a record on /transaction after a withdraw request
✔ SEP-24 ‣ /transaction ‣ has proper 'incomplete' deposit transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ has proper 'pending_' deposit transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ has proper 'completed' deposit transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ has proper 'incomplete' withdraw transaction schema on /transaction
▸ SEP-24 ‣ /transaction ‣ has proper 'pending_user_transfer_start' withdraw transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ has proper 'completed' withdraw transaction schema on /transaction
✔ SEP-24 ‣ /transaction ‣ returns valid deposit transaction when using 'stellar_transaction_id' param
✔ SEP-24 ‣ /transaction ‣ returns valid withdraw transaction when using 'stellar_transaction_id' param
✔ SEP-24 ‣ /transaction ‣ has a valid 'more_info_url'
✔ SEP-24 ‣ /transaction ‣ returns 404 for a nonexistent transaction 'id'
✔ SEP-24 ‣ /transaction ‣ returns 404 for a nonexistent 'external_transaction_id'
✔ SEP-24 ‣ /transaction ‣ returns 404 for a nonexistent 'stellar_transaction_id'
✔ SEP-24 ‣ /transactions ‣ requires a SEP-10 JWT on /transactions
✔ SEP-24 ‣ /transactions ‣ has a record on /transactions after a deposit request
✔ SEP-24 ‣ /transactions ‣ has a record on /transactions after a withdraw request
✔ SEP-24 ‣ /transactions ‣ has proper deposit transaction schema on /transactions
✔ SEP-24 ‣ /transactions ‣ has proper withdraw transaction schema on /transactions
✔ SEP-24 ‣ /transactions ‣ returns an empty list for accounts with no transactions
✔ SEP-24 ‣ /transactions ‣ returns proper number of transactions when 'limit' parameter is given
✔ SEP-24 ‣ /transactions ‣ transactions are returned in descending order of creation
✔ SEP-24 ‣ /transactions ‣ returns proper transactions when 'no_older_than' parameter is given
✔ SEP-24 ‣ /transactions ‣ only returns withdraw transactions when kind=withdrawal
✔ SEP-24 ‣ /transactions ‣ only returns deposit transactions when kind=deposit
✔ SEP-24 ‣ /transactions ‣ rejects requests with a bad 'asset_code' parameter

Tests:       42 passed, 1 skipped, 43 total
Time:        9.218s
suite exit=0
suite end 2026-09-04T20:12:29Z
```

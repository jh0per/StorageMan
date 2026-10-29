# StorageMan Privacy Policy

Effective date: 29 October 2026

This policy covers the StorageMan mobile app for Android and iOS (package
`com.datawithart.storageman`) and the self-hosted StorageMan dashboard in this repository.
StorageMan shows the earnings, storage and health of Storj storage nodes and Sia hosts
that you operate.

## Summary

- StorageMan has no accounts and no server of its own. The developer does not receive
  your node addresses, your passwords or your earnings.
- The node addresses and API passwords you enter stay on your device.
- The Android app shows ads from Google AdMob, which collects data as described below.
  The iOS app shows no ads.

## Data you enter

- **Node addresses** (host and port of your Storj nodes and Sia hosts) and **Sia API
  passwords**. They are stored only on your device and are not included in backups: on
  Android in app-private storage, with the passwords encrypted by the Android Keystore, and
  excluded from cloud backups and device-to-device transfers; on iOS in the Keychain as
  items that stay on this device.
- **Figures from your nodes** (earnings, storage, bandwidth, scores) are kept on the device
  for the app and its home-screen widget. On iOS the widget's earnings summary (totals only,
  no addresses or passwords) is stored in the app's shared settings, which can be part of
  your device backup.

Deleting a node in the app removes its address and password from the device; uninstalling
the app removes all of its data.

## Network connections

- **Your nodes.** The app connects directly from your device to the addresses you enter.
  The Sia API password is sent to that node as HTTP Basic authentication. Use `https://`
  addresses for nodes outside your local network; the app marks unencrypted connections.
- **Exchange rate.** To show Siacoin amounts in US dollars the app requests the public
  SC/USD rate from SiaScan (`api.siascan.com`) and, as a fallback, CoinGecko
  (`api.coingecko.com`). These requests contain no data about you or your nodes; like any
  web request they reveal your IP address to those services.

## Ads (Android only)

The Android app shows banner ads from **Google AdMob**. Google may collect and use the
advertising ID, device and app information, your IP address and ad interactions to show,
measure and personalise ads, as described in
[How Google uses information from sites or apps that use its services](https://policies.google.com/technologies/partner-sites).
In the EEA, the UK and Switzerland the app asks for your consent through Google's User
Messaging Platform before ads are personalised; you can change your choice at any time
under **Privacy settings** in the app menu. You can also reset or delete the advertising ID
in your Android settings.

## Purchases (Android only)

The optional "Remove ads" purchase is processed by **Google Play**. The developer does not
receive your payment details; the app only stores on the device whether the purchase is
active. See the [Google Play Terms of Service](https://play.google.com/about/play-terms/).

## Analytics and tracking

StorageMan contains no analytics, crash-reporting or tracking SDKs and does not share data
with data brokers. The iOS app does not track you across apps or websites.

## Self-hosted dashboard

The dashboard in this repository runs on your own server and reads node addresses and
passwords from that server's configuration. It sends them only to your nodes and has no
connection to the developer.

## Children

StorageMan is meant for people who operate storage nodes and is not directed at children
under 13.

## Changes

Changes to this policy are published in this file; the effective date above shows the
latest version. The history of the file is available in this repository.

## Contact

Questions about this policy: open an issue at
<https://github.com/jh0per/StorageMan/issues>.

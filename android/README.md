# HJ GROUPS Telegram Auto Sender - Android / Termux

## Goal

Use the working Telegram Auto Sender directly from an Android phone.

Normal use:

1. Tap the HJ-Auto-Sender shortcut.
2. Paste one range link.
3. Press Enter.
4. The tool sends that link to the configured third-party bot.
5. It waits 10 minutes.
6. It generates the next five-message range automatically.
7. It keeps going until stopped.

Example:

799-803
804-808
809-813
814-818

## First-time setup

Install Termux from an official Termux distribution source. The Termux project says Google Play Store builds are deprecated; F-Droid is a supported distribution source.

Install Termux:Widget to create home-screen shortcuts. It runs scripts from ~/.shortcuts. The project currently documents foreground shortcuts in ~/.shortcuts and background tasks in ~/.shortcuts/tasks.

For reboot auto-resume, install Termux:Boot. It runs scripts placed in ~/.termux/boot at device boot.

Open Termux and run:

    git clone https://github.com/hilalaha1233203-tech/HJ-Telegram-Streaming.git
    cd HJ-Telegram-Streaming
    bash android/termux-setup.sh

If the repository is already present, the setup script updates it with git pull.

Then install/open Termux:Widget once and add its widget/shortcut to the Android home screen.

## First Telegram login

The first Auto Sender run uses the Telegram USER account and asks for:

Phone number
Telegram login code
2FA password if enabled

The session is saved locally as:

telegram-auto-link-session.txt

This is separate from the existing streaming session:

telegram-session.txt

Do not upload or share either session file.

## Normal use

Tap the HJ-Auto-Sender shortcut.

It asks only for:

First link:
https://t.me/c/3607214438/799-803

The target bot, batch size (5), and delay (10 minutes) are saved after initial setup.

The script then handles future ranges automatically.

## Screen off / battery

The automation can continue while the phone screen is off, provided Android does not kill the Termux process. Disable battery optimization for Termux and its add-ons on phones that aggressively stop background apps.

The boot script starts the auto sender again after a phone reboot only when a saved auto-sender job exists.

## Reboot behavior

Before every successful link send, the tool saves the next batch to auto-link-sender-state.json.

After reboot, Termux:Boot runs the boot script. If state exists, auto-link-sender.js --auto-resume continues from the saved next batch without asking for a Telegram login again.

## Controls

P = pause
R = resume
S = stop and save
Ctrl+C = stop and save

## Important limitation

Phone must remain powered on and connected to the internet for Telegram messages to be sent.

The tool does not bypass the third-party bot's limits. It automates the same range-link workflow that would otherwise be performed manually.

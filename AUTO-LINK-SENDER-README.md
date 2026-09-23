# HJ GROUPS Telegram Auto Link Sender

This tool automates the workflow where a third-party Telegram bot accepts a link containing five message IDs, processes that batch, and requires the next link after 10 minutes.

## What it does

Input:

https://t.me/c/3607214438/799-803

The tool sends:

1. https://t.me/c/3607214438/799-803
2. waits 10 minutes
3. https://t.me/c/3607214438/804-808
4. waits 10 minutes
5. https://t.me/c/3607214438/809-813
6. continues until the configured last message ID, or until you stop it.

The first range must contain the configured batch size. The default is 5.

## Important

The tool logs in as your normal Telegram USER account through MTProto. It does not log in as a Telegram bot.

That means the destination can remain a third-party bot. The account must be able to open and message that bot normally in Telegram.

The generated telegram-session.txt is a private authentication credential. Never upload it to GitHub, paste it into chat, or share it with anyone.

## Windows setup

From the repository folder:

    npm install

Create .env if you do not already have one:

    API_ID=your_telegram_api_id
    API_HASH=your_telegram_api_hash
    AUTO_TARGET_BOT=@your_target_bot
    AUTO_BATCH_SIZE=5
    AUTO_DELAY_SECONDS=600
    AUTO_RETRY_DELAY_SECONDS=30

TELEGRAM_API_ID and TELEGRAM_API_HASH can also be used instead of API_ID and API_HASH.

If the current HJ Telegram Streaming project already has working Telegram API credentials in .env, the same values can be reused.

Start:

    npm run auto-link

On first run, the program asks for your phone number, Telegram login code, and 2FA password if needed. It then saves the MTProto user session locally so later runs do not require another login.

## Running

Example:

    First link:
    https://t.me/c/3607214438/799-803

    Target bot:
    @example_bot

    Batch size:
    5

    Delay:
    600

    Last message ID:
    903

It will automatically produce 799-803, 804-808, 809-813, ... until the configured end.

While running:

- P = pause
- R = resume
- S = stop and save
- Ctrl+C = stop and save

The next batch and sent history are saved in auto-link-sender-state.json, so an interrupted run can be resumed.

## Logs

auto-link-sender.log records sent links, retries, pauses, and errors.

## Why the link changes automatically

A starting range such as 799-803 contains five message IDs. The next batch is calculated as:

    nextStart = previousEnd + 1
    nextEnd   = nextStart + batchSize - 1

So:

    799-803
    804-808
    809-813
    814-818

No Telegram channel message needs to be downloaded by this tool; it only sends the generated range links to the target bot.

## Notes

The third-party bot must accept this exact range-link format. This tool does not attempt to bypass the bot's own restrictions; it simply automates the same links you would otherwise send manually.

If the target bot rejects a link, the tool logs the error and retries after AUTO_RETRY_DELAY_SECONDS.

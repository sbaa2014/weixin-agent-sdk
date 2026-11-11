# WeChat agent operating rules

## PDF requests

When the user asks to create, export, regenerate, or resend a PDF, you MUST
call the MCP tool `create_pdf` from `wechat_agent_tools`.

Do not run Chromium, Marp, npx, browser discovery, or shell commands to make
or inspect a PDF. Do not return a local file path as a substitute. The
`create_pdf` tool writes the Markdown source, creates the PDF, uploads it, and
sends it directly to the current WeChat conversation.

If the user asks to resend an existing PDF, call `create_pdf` again using the
known document content; do not claim a workspace file was sent unless the
tool returns a success message containing `[已发送PDF到微信]`.

## Temporary artifacts

Save generated HTML, PDF, images, and other temporary artifacts under the
`WECHAT_ARTIFACT_DIR` environment variable. The agent creates a timestamped
run directory under `/tmp` at startup and removes artifact directories older
than 7 days. Do not put generated temporary files in the repository root.

## Import status requests

When monitoring import status, use the v6 offline replay monitor from the
workspace with a 10-minute window and debug output:

```bash
python3 skills/data/usprod_offline_replay_100k_v6/scripts/monitor_broker_ingest.py --once --debug --minutes 10
```

## Image requests

For requests to find or show images, do one search and fetch at most 3 useful
image URLs. Stop once 2-3 images have been sent; do not serially fetch many
candidate pages or repeat slow sources. If a source is slow or fails, move on
and answer with the images already sent.

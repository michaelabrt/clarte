# Demo Recording Guide

## Quick Setup

### 1. Terminal Setup
```bash
# Clean prompt
export PS1='$ '

# Nice colors (Tokyo Night theme recommended)
# Font size: 16-18pt
# Font: JetBrains Mono or Fira Code

# Clear history
clear
```

### 2. Run Setup
```bash
bash scripts/record-demo.sh setup
```

This creates `/tmp/codebrief-demo` with 200+ TypeScript files.

### 3. Start Recording
- Open Kap (or Cmd+Shift+5)
- Resize terminal to ~120x36 or full screen
- Start recording
- Focus terminal

### 4. Start Demo
```bash
bash scripts/record-demo.sh record
```

## Demo Flow

The script will automatically:

1. **Navigate** to demo project (2s)
2. **Run** `codebrief` (3s wait for detection)
3. **Browse IDE options** — Shows Cursor, OpenCode, Copilot, then selects Claude Code (3s)
4. **Confirm stack** — Detected React + TypeScript (1s)
5. **Enter purpose** — Types project description (5s)
6. **Enter patterns** — Types key patterns (5s)
7. **Enter gotchas** — Types anti-patterns (4s)
8. **Snapshot** — Generates code snapshot (5s)
9. **Overwrite** — Confirms overwrite (2s)
10. **Done!** — Shows summary with token savings (3.5s)

**Total runtime: ~35 seconds**

## Enhanced Demo Options

### Option A: Add Visual Commentary
Edit script to add boxes at key moments:
```bash
source scripts/demo-helpers.sh
print_box "Analyzing 200+ TypeScript files..."
```

### Option B: Show Generated File
Uncomment at end of `record-demo.sh`:
```bash
type_cmd "head -30 CLAUDE.md"
press_enter
wait_s 3.0 "showing generated file"
```

### Option C: End with Real Task
Add at the very end:
```bash
type_cmd "claude 'Add a dark mode toggle'"
press_enter
wait_s 2.0 "showing Claude using context"
```

## Best Practices

### Before Recording
- [ ] Close unnecessary terminal tabs/windows
- [ ] Clear terminal (`clear`)
- [ ] Test the script once (`record` mode)
- [ ] Check audio/video settings in Kap
- [ ] Disable notifications (Do Not Disturb)

### During Recording
- Keep terminal in focus (script will fail if focus lost)
- Don't touch keyboard/mouse
- Let script complete fully

### After Recording
- Stop Kap recording
- Trim first/last ~1 second in editor
- Export as GIF (under 10MB for GitHub)
- Or export as MP4 for higher quality

## Tips for Great Demos

### Pacing
- ✅ Let key moments breathe (pause after token savings)
- ✅ Not too fast (viewers need to read)
- ✅ Not too slow (keeps attention)

### Visual
- ✅ Clean terminal (no clutter)
- ✅ Good contrast (dark theme + light text)
- ✅ Large enough font (16-18pt minimum)

### Content
- ✅ Show real value (token savings, time saved)
- ✅ Realistic project (200+ files = relatable)
- ✅ Clear outcome (generated files shown)

## Troubleshooting

### Script selects wrong option
- **Issue:** Timing too fast/slow for your system
- **Fix:** Adjust `sleep` durations in script

### Focus lost during recording
- **Issue:** Notifications, other apps stealing focus
- **Fix:** Enable Do Not Disturb, close other apps

### Terminal too small
- **Issue:** Output gets cut off or wrapped badly
- **Fix:** Resize to at least 120x36 before recording (progressive reveal adds many lines)

### Demo project missing
- **Issue:** Forgot to run `setup`
- **Fix:** Run `bash scripts/record-demo.sh setup` first

## Variations

### Quick Demo (10 seconds)
Remove questions, just show:
1. Run command
2. Show detection
3. Show output

### Detailed Demo (60 seconds)
Add:
1. Show project structure first (`tree -L 2`)
2. Show file count (`find . -name "*.ts" | wc -l`)
3. Show generated file (`bat CLAUDE.md`)
4. Run a Claude Code command

### Comparison Demo (45 seconds)
Split screen:
- **Left:** Traditional approach (Claude reading files manually)
- **Right:** With codebrief (instant context)

## Post-Production (Optional)

If editing in video software:

1. **Add captions** explaining each step
2. **Highlight** key numbers (87% savings)
3. **Add arrow** pointing to important text
4. **Speed up** typing slightly (1.2x)
5. **Add music** (subtle, quiet)

## Publishing

### GitHub README
```markdown
![codebrief demo](demo.gif)
```

### Twitter
- Under 60 seconds
- Under 10MB for direct upload
- Add captions (many watch muted)

### YouTube/Loom
- Can be longer (2-3 min)
- Add voiceover explaining each step
- Show before/after comparison

---

**Ready to record?**
```bash
bash scripts/record-demo.sh setup   # One-time
bash scripts/record-demo.sh record  # Each take
```

🎬 Lights, camera, action!

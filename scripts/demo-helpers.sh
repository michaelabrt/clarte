#!/bin/bash
#
# demo-helpers.sh — Visual helpers for demo recordings
#

# Print a fancy box with a message
print_box() {
  local msg="$1"
  local width=60

  echo ""
  printf "╔"
  printf '═%.0s' $(seq 1 $width)
  printf "╗\n"

  printf "║  %-${width}s  ║\n" "$msg"

  printf "╚"
  printf '═%.0s' $(seq 1 $width)
  printf "╝\n"
  echo ""
}

# Print a simple header
print_header() {
  local msg="$1"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $msg"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

# Print a subtle annotation
print_note() {
  local msg="$1"
  echo ""
  echo "  💡 $msg"
  echo ""
}

# Print success message
print_success() {
  local msg="$1"
  echo ""
  echo "  ✅ $msg"
  echo ""
}

# Print metric/stat
print_metric() {
  local label="$1"
  local value="$2"
  echo "  $label: $value"
}

# Simulate typing with visible cursor
fancy_type() {
  local text="$1"
  local delay="${2:-0.05}"

  for ((i=0; i<${#text}; i++)); do
    echo -n "${text:$i:1}"
    sleep "$delay"
  done
  echo ""
}

# Show a countdown
countdown() {
  local seconds="$1"
  for ((i=$seconds; i>0; i--)); do
    echo -ne "\r  Starting in $i... "
    sleep 1
  done
  echo -e "\r  Starting now!      "
}

# Example usage:
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Demo Helper Functions:"
  echo ""

  print_box "This is a fancy box message"
  print_header "This is a header"
  print_note "This is a helpful note"
  print_success "Operation completed!"

  echo ""
  print_metric "Files analyzed" "200"
  print_metric "Token savings" "87%"

  echo ""
  echo "Fancy typing:"
  fancy_type "npx context-pilot" 0.08

  echo ""
  echo "Countdown example:"
  countdown 3
fi

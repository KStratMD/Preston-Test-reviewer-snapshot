#!/usr/bin/env bash
set -euo pipefail

CLOC_VERSION="1.98"
CLOC_SHA256="94cba5168e6d1b72100513d6660a31ebb6a91670cf501816efa71d6e1da6d58a"
GITLEAKS_VERSION="8.18.0"
GITLEAKS_LINUX_X64_SHA256="6e19050a3ee0688265ed3be4c46a0362487d20456ecd547e8c7328eaed3980cb"
GITLEAKS_LINUX_ARM64_SHA256="c19c2af7087e1c2bd502f85ae92e6477133fc43ce17f5ea09f63ebda6e3da0be"
TRUFFLEHOG_VERSION="3.63.0"
TRUFFLEHOG_LINUX_AMD64_SHA256="836cd48d5864a25194c2b6ed1b9dc8d68367a2ee2afb00655306b18359b3cc0d"
TRUFFLEHOG_LINUX_ARM64_SHA256="4e3da13e733abbc1a558946357621cc19269fb32ff540ff44a04c0a8e63d4234"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "bootstrap-review-tools.sh currently supports Linux CI runners only. Install cloc, gitleaks, and trufflehog manually on other platforms." >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "bootstrap-review-tools.sh requires sha256sum for tool checksum verification." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

path_prepend() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) export PATH="$INSTALL_DIR:$PATH" ;;
  esac
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  printf '%s  %s\n' "$expected" "$file" | sha256sum -c -
}

install_cloc() {
  if command -v cloc >/dev/null 2>&1 && cloc --version | grep -Fxq "$CLOC_VERSION"; then
    echo "cloc $CLOC_VERSION already installed"
    return
  fi

  echo "Installing cloc $CLOC_VERSION"
  curl -sSfL \
    -o /tmp/cloc-"$CLOC_VERSION".pl \
    "https://github.com/AlDanial/cloc/releases/download/v${CLOC_VERSION}/cloc-${CLOC_VERSION}.pl"
  verify_sha256 /tmp/cloc-"$CLOC_VERSION".pl "$CLOC_SHA256"
  install -m 755 /tmp/cloc-"$CLOC_VERSION".pl "$INSTALL_DIR/cloc"
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1 && [[ "$(gitleaks version)" == *"$GITLEAKS_VERSION"* ]]; then
    echo "gitleaks $GITLEAKS_VERSION already installed"
    return
  fi

  echo "Installing gitleaks $GITLEAKS_VERSION"
  local arch asset expected_sha
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      asset="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
      expected_sha="$GITLEAKS_LINUX_X64_SHA256"
      ;;
    aarch64|arm64)
      asset="gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"
      expected_sha="$GITLEAKS_LINUX_ARM64_SHA256"
      ;;
    *)
      echo "Unsupported gitleaks architecture: $arch" >&2
      exit 1
      ;;
  esac

  rm -rf /tmp/gitleaks-review-tools
  mkdir -p /tmp/gitleaks-review-tools
  curl -sSfL \
    -o /tmp/gitleaks-review-tools/gitleaks.tar.gz \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}"
  verify_sha256 /tmp/gitleaks-review-tools/gitleaks.tar.gz "$expected_sha"
  tar xzf /tmp/gitleaks-review-tools/gitleaks.tar.gz -C /tmp/gitleaks-review-tools gitleaks
  install -m 755 /tmp/gitleaks-review-tools/gitleaks "$INSTALL_DIR/gitleaks"
}

install_trufflehog() {
  if command -v trufflehog >/dev/null 2>&1 && [[ "$(trufflehog --version 2>&1)" == *"$TRUFFLEHOG_VERSION"* ]]; then
    echo "trufflehog $TRUFFLEHOG_VERSION already installed"
    return
  fi

  echo "Installing trufflehog $TRUFFLEHOG_VERSION"
  local os arch asset archive_url expected_sha
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$arch" in
    x86_64|amd64)
      arch="amd64"
      expected_sha="$TRUFFLEHOG_LINUX_AMD64_SHA256"
      ;;
    aarch64|arm64)
      arch="arm64"
      expected_sha="$TRUFFLEHOG_LINUX_ARM64_SHA256"
      ;;
    *)
      echo "Unsupported trufflehog architecture: $arch" >&2
      exit 1
      ;;
  esac

  asset="trufflehog_${TRUFFLEHOG_VERSION}_${os}_${arch}.tar.gz"
  archive_url="https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/${asset}"

  rm -rf /tmp/trufflehog-review-tools
  mkdir -p /tmp/trufflehog-review-tools
  curl -sSfL -o "/tmp/trufflehog-review-tools/$asset" "$archive_url"
  echo "${expected_sha}  /tmp/trufflehog-review-tools/${asset}" | sha256sum -c -
  tar xzf "/tmp/trufflehog-review-tools/$asset" -C /tmp/trufflehog-review-tools trufflehog
  install -m 755 /tmp/trufflehog-review-tools/trufflehog "$INSTALL_DIR/trufflehog"
}

verify_versions() {
  path_prepend

  local cloc_version
  cloc_version="$(cloc --version)"
  if [[ "$cloc_version" != "$CLOC_VERSION" ]]; then
    echo "Expected cloc $CLOC_VERSION, got: $cloc_version" >&2
    exit 1
  fi

  local gitleaks_version
  gitleaks_version="$(gitleaks version)"
  if [[ "$gitleaks_version" != *"$GITLEAKS_VERSION"* ]]; then
    echo "Expected gitleaks $GITLEAKS_VERSION, got: $gitleaks_version" >&2
    exit 1
  fi

  local trufflehog_version
  trufflehog_version="$(trufflehog --version 2>&1)"
  if [[ "$trufflehog_version" != *"$TRUFFLEHOG_VERSION"* ]]; then
    echo "Expected trufflehog $TRUFFLEHOG_VERSION, got: $trufflehog_version" >&2
    exit 1
  fi

  echo "Review tools ready:"
  echo "  cloc: $cloc_version"
  echo "  gitleaks: $gitleaks_version"
  echo "  trufflehog: $trufflehog_version"
}

path_prepend
install_cloc
install_gitleaks
install_trufflehog
verify_versions

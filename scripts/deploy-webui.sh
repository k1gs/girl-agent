#!/usr/bin/env bash
# girl-agent — WebUI deploy script
# Generates certificates, configures Nginx, and starts Docker Compose.

set -e

# Change to repository root
cd "$(dirname "$0")/.." || { echo "cd failed"; return 1 2>/dev/null || true; }

say() { printf "\033[1m[girl-agent]\033[0m %s\n" "$1" >&2; }
ok()  { printf "\033[1m[girl-agent]\033[0m \033[32m%s\033[0m\n" "$1" >&2; }
warn(){ printf "\033[1m[girl-agent]\033[0m \033[33m%s\033[0m\n" "$1" >&2; }

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не установлен. Установите docker."
  return 1 2>/dev/null || true
fi

mkdir -p docker/nginx/ssl

say "=== Установка WebUI для girl-agent ==="
echo ""
echo "Есть ли у вас доменное имя, привязанное к IP-адресу этого сервера? (y/N)"
read -r HAS_DOMAIN

DOMAIN_OR_IP=""

if [[ "$HAS_DOMAIN" =~ ^[Yy] ]]; then
  echo "Введите ваше доменное имя (например, bot.example.com):"
  read -r DOMAIN_OR_IP
  say "Используем Certbot для получения Let's Encrypt сертификата..."

  if ! command -v certbot >/dev/null 2>&1; then
    warn "Certbot не установлен. Пытаюсь установить..."
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y certbot
    else
      echo "Установите certbot вручную и запустите скрипт заново."
      return 1 2>/dev/null || true
    fi
  fi

  # Остановка nginx если он занимает 80 порт
  if docker ps | grep -q girl-agent-nginx; then
    docker stop girl-agent-nginx || true
  fi

  sudo certbot certonly --standalone -d "$DOMAIN_OR_IP" --non-interactive --agree-tos -m "admin@$DOMAIN_OR_IP"
  sudo cp "/etc/letsencrypt/live/$DOMAIN_OR_IP/fullchain.pem" "docker/nginx/ssl/cert.pem"
  sudo cp "/etc/letsencrypt/live/$DOMAIN_OR_IP/privkey.pem" "docker/nginx/ssl/key.pem"
  sudo chown $(id -u):$(id -g) docker/nginx/ssl/*.pem
else
  echo "Введите IP-адрес вашего сервера (чтобы вывести вам правильную ссылку в конце):"
  read -r DOMAIN_OR_IP
  say "Генерируем самоподписанный SSL сертификат..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout docker/nginx/ssl/key.pem \
    -out docker/nginx/ssl/cert.pem \
    -subj "/CN=$DOMAIN_OR_IP" 2>/dev/null
  warn "Внимание: при первом входе браузер покажет предупреждение 'Небезопасное подключение'. Это нормально для самоподписанных сертификатов. Продолжите переход."
fi

say "Копирую шаблоны конфигураций..."
cp docker-compose.example.yml docker-compose.yml
cp docker/nginx/nginx.example.conf docker/nginx/nginx.conf

say "Создаю/обновляю bot.json..."
if [ ! -f bot.json ]; then
  docker run --rm ghcr.io/thesashadev/girl-agent:latest server --print-config > bot.json
fi

echo "Введите токен вашего Telegram-бота:"
read -r TG_TOKEN
echo "Введите ваш API ключ (OpenAI/Anthropic/ClaudeHub):"
read -r API_KEY

# Кроссплатформенный способ замены (работает и на Mac и на Linux без проблем с -i)
sed "s/\"botToken\": \".*\"/\"botToken\": \"$TG_TOKEN\"/" bot.json > bot.json.tmp && mv bot.json.tmp bot.json
sed "s/\"apiKey\": \".*\"/\"apiKey\": \"$API_KEY\"/" bot.json > bot.json.tmp && mv bot.json.tmp bot.json

ok "Настройки сохранены в bot.json!"

say "Поднимаю сервисы..."
docker compose up -d

say "Жду 3 секунды, чтобы бот успел сгенерировать токен..."
sleep 3

TOKEN=$(docker compose logs girl-agent | grep -o 'token=[a-f0-9]*' | head -n 1 | cut -d '=' -f 2)

if [ -z "$TOKEN" ]; then
  warn "Не удалось автоматически найти токен в логах."
  warn "Посмотрите логи: docker compose logs girl-agent"
  TOKEN="<ВАШ_ТОКЕН>"
fi

echo ""
ok "=== ГОТОВО ==="
echo "Дашборд доступен по безопасной ссылке:"
ok "https://$DOMAIN_OR_IP/?token=$TOKEN"
echo ""
echo "Логи бота: docker compose logs -f girl-agent"
echo "Остановить: docker compose down"

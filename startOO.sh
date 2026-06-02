docker run -i -t -d -p 8080:80 --restart=always \
  -e JWT_ENABLED=false \
  -e ALLOW_PRIVATE_IP_ADDRESS=true \
  -v ~/onlyoffice/logs:/var/log/onlyoffice \
  -v ~/onlyoffice/data:/var/www/onlyoffice/Data \
  -v ~/onlyoffice/lib:/var/lib/onlyoffice \
  -v ~/onlyoffice/db:/var/lib/postgresql \
  onlyoffice/documentserver

echo "
rdr pass inet proto tcp from any to any port 80 -> 127.0.0.2 port 8080
" | sudo pfctl -ef -
sudo ifconfig lo0 alias 127.0.0.2 up
cd ~/WebstormProjects/tasks/
/usr/local/bin/node index.js > /dev/null 2>&1 &
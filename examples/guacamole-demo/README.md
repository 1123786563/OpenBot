# Guacamole desktop demo

This disposable demo connects Apache Guacamole to a Linux graphical desktop through VNC. It demonstrates the human side of a native-app login handoff: seeing the same desktop and typing into a native window. It does not connect to OpenBot's Computer gateway or automate an Agent pause/resume.

## Run

From this directory:

```sh
docker compose up --build -d
```

Open <http://127.0.0.1:18080/> and sign in with `demo` / `demo-local-only`. Open **OpenBot native desktop demo**. Click the terminal window and type to confirm the keyboard and screen both work.

Stop and remove the demo with:

```sh
docker compose down
```

The Guacamole port is bound to host loopback. The VNC and guacd ports are available only on this Compose network. The static login and passwordless internal VNC server are for this local demo only. Guacamole's `user-mapping.xml` authentication is not intended for production; a real OpenBot integration would authenticate the signed-in user, issue scoped access to one desktop, and suspend Agent input during human control.

Guacamole is Apache-2.0 licensed. The desktop image installs Ubuntu packages, including x11vnc; review their package licenses if redistributing the image.

References: [Guacamole Docker setup](https://guacamole.apache.org/doc/gug/guacamole-docker.html), [user mapping and VNC connection](https://guacamole.apache.org/doc/gug/configuring-guacamole.html).

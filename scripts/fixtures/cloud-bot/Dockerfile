FROM node:22.22.3-bookworm
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends systemd systemd-sysv dbus openssh-server libpam-systemd sudo ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1001 --shell /bin/bash hemi && \
    mkdir -p /run/sshd /var/lib/systemd/linger && touch /var/lib/systemd/linger/hemi && \
    ssh-keygen -A && \
    printf '\nPasswordAuthentication no\nUsePAM yes\nPermitRootLogin no\n' >> /etc/ssh/sshd_config && \
    systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

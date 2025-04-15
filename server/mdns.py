import logging
import socket
import struct
import threading
import time

# Configuration
SERVICE_NAME = "spectre"
SERVICE_TYPE = "_http._tcp.local."
INSTANCE_NAME = f"{SERVICE_NAME}.{SERVICE_TYPE}"
HOSTNAME = f"{SERVICE_NAME}.local."
SERVICE_PORT = 80
TTL = 120  # Time to live for mDNS records in seconds
ANNOUNCE_INTERVAL = 60  # seconds
RECV_BUFFER_SIZE = 4096  # Buffer size for recvfrom
MIN_RESPONSE_INTERVAL = 2  # Minimum interval (in seconds) between responses

MULTICAST_GROUP = "224.0.0.251"
MDNS_PORT = 5353

# Setup logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("mdns_responder")


def get_local_ip() -> str:
    """Determine the primary local IP address by connecting to an external host."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # This does not send any data but helps determine the outbound IP
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception as e:
        logger.error("Could not determine local IP, defaulting to 127.0.0.1: %s", e)
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def encode_name(name: str) -> bytes:
    """Encodes a domain name in the standard DNS format."""
    parts = name.strip('.').split('.')
    result = b''
    for part in parts:
        if part:
            result += struct.pack("B", len(part)) + part.encode("utf-8")
    return result + b'\x00'


def build_ptr_record(service_type: str, instance_name: str, ttl: int) -> bytes:
    """Builds a PTR record mapping the service type to the instance name."""
    name = encode_name(service_type)
    rdata = encode_name(instance_name)
    record = name
    record += struct.pack("!HHI", 12, 1, ttl)  # TYPE=PTR (12), CLASS=IN (1), TTL
    record += struct.pack("!H", len(rdata))
    record += rdata
    return record


def build_srv_record(instance_name: str, hostname: str, port: int, ttl: int) -> bytes:
    """Builds an SRV record with service details."""
    name = encode_name(instance_name)
    priority = 0
    weight = 0
    srv_data = struct.pack("!HHH", priority, weight, port) + encode_name(hostname)
    record = name
    record += struct.pack("!HHI", 33, 1, ttl)  # TYPE=SRV (33), CLASS=IN (1), TTL
    record += struct.pack("!H", len(srv_data))
    record += srv_data
    return record


def build_txt_record(instance_name: str, txt: str, ttl: int) -> bytes:
    """Builds a TXT record with service metadata."""
    name = encode_name(instance_name)
    txt_bytes = txt.encode("utf-8")
    txt_record = struct.pack("B", len(txt_bytes)) + txt_bytes
    record = name
    record += struct.pack("!HHI", 16, 1, ttl)  # TYPE=TXT (16), CLASS=IN (1), TTL
    record += struct.pack("!H", len(txt_record))
    record += txt_record
    return record


def build_a_record(hostname: str, ip: str, ttl: int) -> bytes:
    """Builds an A record mapping the hostname to an IP address."""
    name = encode_name(hostname)
    a_data = socket.inet_aton(ip)
    record = name
    record += struct.pack("!HHI", 1, 1, ttl)  # TYPE=A (1), CLASS=IN (1), TTL
    record += struct.pack("!H", len(a_data))
    record += a_data
    return record


class MDNSResponder:
    def __init__(self, hostname: str, ip: str, port: int):
        self.hostname = hostname
        self.ip = ip
        self.port = port
        self.running = False
        self.sock = None
        self.last_response_time = 0  # For rate-limiting responses

    def start(self):
        try:
            self.running = True
            self.sock = self._create_socket()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
            logger.info("mDNS responder started on IP %s", self.ip)
        except Exception as e:
            logger.exception("Failed to start mDNS responder: %s", e)

    def stop(self):
        try:
            self.running = False
            if self.sock:
                self.sock.close()
            logger.info("mDNS responder stopped")
        except Exception as e:
            logger.exception("Error stopping mDNS responder: %s", e)

    def _create_socket(self):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(('', MDNS_PORT))
            # Bind the multicast interface explicitly to the correct local IP.
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(self.ip))
            # Join the mDNS multicast group on this interface.
            mreq = struct.pack("4s4s", socket.inet_aton(MULTICAST_GROUP), socket.inet_aton(self.ip))
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            return sock
        except Exception as e:
            logger.exception("Error creating mDNS socket: %s", e)
            raise

    def _run(self):
        next_announce = time.time()
        while self.running:
            now = time.time()
            if now >= next_announce:
                self._send_announcement()
                next_announce = now + ANNOUNCE_INTERVAL

            try:
                self.sock.settimeout(1)
                # Use the increased buffer size to avoid message truncation errors.
                data, addr = self.sock.recvfrom(RECV_BUFFER_SIZE)
                # Only respond if the query is for our service and did not come from our own IP.
                if addr[0] != self.ip and self._is_query_for_our_service(data):
                    current_time = time.time()
                    if current_time - self.last_response_time >= MIN_RESPONSE_INTERVAL:
                        logger.debug("Received query from %s, responding...", addr)
                        self._send_announcement()
                        self.last_response_time = current_time
                    else:
                        logger.debug("Query from %s ignored due to rate limiting", addr)
            except socket.timeout:
                continue
            except Exception as e:
                logger.exception("Error in mDNS responder loop: %s", e)

    def _send_announcement(self):
        try:
            packet = self._build_response_packet()
            self.sock.sendto(packet, (MULTICAST_GROUP, MDNS_PORT))
            logger.debug("Sent mDNS announcement")
        except Exception as e:
            logger.exception("Failed to send mDNS announcement: %s", e)

    def _build_response_packet(self):
        """Construct a multi-record mDNS response including PTR, SRV, TXT, and A records."""
        try:
            answers = []
            answers.append(build_ptr_record(SERVICE_TYPE, INSTANCE_NAME, TTL))
            answers.append(build_srv_record(INSTANCE_NAME, self.hostname, SERVICE_PORT, TTL))
            answers.append(build_txt_record(INSTANCE_NAME, "path=/", TTL))
            answers.append(build_a_record(self.hostname, self.ip, TTL))

            header = struct.pack("!6H", 0, 0x8400, 0, len(answers), 0, 0)
            packet = header + b"".join(answers)
            return packet
        except Exception as e:
            logger.exception("Error building mDNS response packet: %s", e)
            return b""

    def _is_query_for_our_service(self, data):
        """Parse the query and check if it is for our A record or service type."""
        try:
            question_section = data[12:]
            hostname_bytes = b""
            i = 0
            while i < len(question_section) and question_section[i] != 0:
                length = question_section[i]
                hostname_bytes += question_section[i + 1 : i + 1 + length] + b"."
                i += 1 + length
            query_name = hostname_bytes.decode("utf-8").strip(".").lower()
            expected_a = self.hostname.strip(".").lower()
            expected_ptr = SERVICE_TYPE.strip(".").lower()
            return query_name == expected_a or query_name == expected_ptr
        except Exception as e:
            logger.error("Failed to parse query: %s", e)
            return False


def start_mdns_advertisement(service_ip: str = None):
    try:
        if service_ip is None:
            service_ip = get_local_ip()
        responder = MDNSResponder(hostname=HOSTNAME, ip=service_ip, port=SERVICE_PORT)
        responder.start()
        return responder
    except Exception as e:
        logger.exception("Error starting mDNS advertisement: %s", e)
        return None


if __name__ == "__main__":
    try:
        ip_address = get_local_ip()
        logger.info("Using local IP: %s", ip_address)
        responder = start_mdns_advertisement(ip_address)
        input("Advertising mDNS service. Press Enter to stop.")
        if responder:
            responder.stop()
    except Exception as e:
        logger.exception("Fatal error: %s", e)

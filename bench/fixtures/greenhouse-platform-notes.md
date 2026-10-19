# Greenhouse platform - architecture notes

Sensors POST readings to the ingest gateway. Readings are published to the telemetry topic keyed by
greenhouseId; the topic has 48 partitions. The aggregator consumer writes 5-second rollups to the
time-series store. Raw readings are retained for 400 days. Rollups are retained for five years.

The dashboard reads rollups only and refreshes every 5 seconds. Alert rules evaluate in the stream
processor and page the on-call rotation. The audit log records every configuration change with the
actor and timestamp. The platform runs active-passive across two regions with a 15 minute RTO and
an RPO of one minute.

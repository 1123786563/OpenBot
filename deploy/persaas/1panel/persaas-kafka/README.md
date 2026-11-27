# Persaas Kafka

Flexprice v2.1.52 的 Sarama 客户端不能消费 Kafka 4.0。此 1Panel 本地应用复用现有 Bitnami KRaft 配方，将镜像固定为 Kafka 3.9.0，使用独立数据目录，不降级或覆盖原 Kafka 4.0 数据。

单节点部署不提供高可用。端口仅绑定回环，容器通过 1panel-network 访问。Flexprice topic 保留期由迁移配置设为七天。

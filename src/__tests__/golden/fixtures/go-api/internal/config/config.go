package config

type Config struct {
	Addr     string
	DBHost   string
	LogLevel string
}

func Load() *Config {
	return &Config{
		Addr:     ":8080",
		DBHost:   "localhost:5432",
		LogLevel: "info",
	}
}

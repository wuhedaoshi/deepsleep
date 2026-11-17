import java.util.Properties

plugins { id("com.android.application") }

// 版本号唯一真源；递增由 build-apk.ps1 / build-apk.sh 在打包前完成，这里只读。
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}

// 签名材料一律不进仓库：可以从 Gradle 属性（-Pdeepsleep.xxx）、local.properties
// 或环境变量（DEEPSLEEP_XXX）取。三处都没有时退化成不签名，至少还能 assembleDebug。
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) {
        file.inputStream().use { load(it) }
    }
}

fun secret(name: String): String? =
    (project.findProperty("deepsleep.$name") as String?)
        ?: localProps.getProperty("deepsleep.$name")
        ?: System.getenv("DEEPSLEEP_${name.uppercase().replace('.', '_')}")
        ?: System.getenv("DEEPSLEEP_${name.replace(".", "").uppercase()}")

// 注意别叫 storePassword / keyPassword：那会和 SigningConfig 自己的属性同名，x = x 会赋成属性本身。
val keystorePath = secret("keystore")
val keystorePass = secret("storePassword")
val keyPass = secret("keyPassword") ?: keystorePass
val canSign = keystorePath != null && keystorePass != null && file(keystorePath).exists()

android {
    namespace = "com.deepsleep.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.deepsleep.app"
        minSdk = 21
        targetSdk = 34
        versionCode = versionProps.getProperty("versionCode").trim().toInt()
        versionName = versionProps.getProperty("versionName").trim()
        // 本地服务端口 = WebView 的 origin。改端口等于换存储命名空间，
        // 已装的 IndexedDB / localStorage 会读不到，所以这个值从 1.0.0 起没动过。
        buildConfigField("int", "PORT", "8731")
    }

    signingConfigs {
        if (canSign) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePass
                keyAlias = secret("keyAlias") ?: "deepsleep"
                keyPassword = keyPass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (canSign) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                println("warn: 没有配置签名（keystore / storePassword），release 包将未签名。见 README「构建」。")
            }
        }
        debug {
            if (canSign) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    // AGP 8 起 BuildConfig 默认不生成；MainActivity 要读 BuildConfig.PORT。
    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

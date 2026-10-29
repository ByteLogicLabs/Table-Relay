plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// The updater: reads the version manifest (version.rc, JSON) at updateUrl (gradle.properties; -PupdateUrl=… for a test
// server), downloads the APK it names, checks it against the listed SHA-256 and hands it to Android's package
// installer. Downloading needs a licence token, from signing in with a one-time code sent to the buyer's email
// (licenceApi).
val updateUrl = findProperty("updateUrl") as String
val licenceApi = findProperty("licenceApi") as String

android {
    namespace = "com.brainfactory.db.update"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        buildConfigField("String", "UPDATE_URL", "\"$updateUrl\"")
        buildConfigField("String", "LICENCE_API", "\"$licenceApi\"")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":core-ui"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.json)
}

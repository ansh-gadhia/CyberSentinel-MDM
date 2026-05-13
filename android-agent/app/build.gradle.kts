plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.mdm.agent"
    compileSdk = Versions.compileSdk

    defaultConfig {
        applicationId = "com.mdm.agent"
        minSdk = Versions.minSdk
        targetSdk = Versions.targetSdk
        versionCode = Versions.versionCode
        versionName = Versions.versionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug") // replace with real cert
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    // No composeOptions{} needed — the org.jetbrains.kotlin.plugin.compose
    // plugin (applied above) drives the Compose compiler in Kotlin 2.0+.
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(project(":mdm-core"))
    implementation(project(":enrollment"))
    implementation(project(":policy-engine"))
    implementation(project(":command-executor"))
    implementation(project(":telemetry"))
    implementation(project(":networking"))
    implementation(project(":security"))

    implementation(platform(Deps.composeBom))
    implementation(Deps.composeUi)
    implementation(Deps.composeMaterial3)
    implementation(Deps.composeIcons)
    implementation(Deps.activityCompose)
    implementation(Deps.navigationCompose)
    implementation(Deps.lifecycleRuntime)
    implementation(Deps.lifecycleVMCompose)

    implementation(Deps.hiltAndroid)
    ksp(Deps.hiltCompiler)
    implementation(Deps.hiltNavCompose)
    implementation(Deps.hiltWork)
    ksp(Deps.hiltWorkCompiler)

    implementation(Deps.workmanager)
    implementation(Deps.coroutines)
    implementation(Deps.serializationJson)
    implementation(Deps.timber)
}

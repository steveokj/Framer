use std::env;

fn print_usage() {
    println!("timestone_recorder");
    println!("Usage:");
    println!("  timestone_recorder start");
    println!("  timestone_recorder stop");
    println!("  timestone_recorder status");
}

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("start") => {
            println!("Recorder start requested (stub).");
        }
        Some("stop") => {
            println!("Recorder stop requested (stub).");
        }
        Some("status") => {
            println!("Recorder status (stub).");
        }
        _ => {
            print_usage();
        }
    }
}
